// string.js — Lua string library: basics, pattern functions, string.format.
import {
  LuaError, LuaTable, LuaClosure, NativeFunction,
  callValue, index, tostringMM, typeName, truthy,
  numberToString, setStringLibrary,
} from '../runtime.js';
import { registrar, checkStr, checkNum, optNum } from './helpers.js';
import { match as patMatch, capturesOf } from './lpattern.js';
import { closureUpvalues, DUMP_MAGIC } from '../interp.js';

// Lua 1-based relative string position -> 1-based absolute (may be out of range).
function posrelat(pos, len) {
  pos = Math.trunc(pos);
  return pos >= 0 ? pos : len + pos + 1;
}

// ---------- string.format ----------

function fmtPad(s, flags, width, padZero) {
  if (s.length >= width) return s;
  if (flags.includes('-')) return s + ' '.repeat(width - s.length);
  if (padZero && flags.includes('0')) {
    let sign = '';
    if (s[0] === '-' || s[0] === '+' || s[0] === ' ') {
      sign = s[0];
      s = s.slice(1);
    }
    return sign + '0'.repeat(width - sign.length - s.length) + s;
  }
  return ' '.repeat(width - s.length) + s;
}

function fmtSign(n, flags) {
  if (n >= 0 || Object.is(n, 0)) {
    if (flags.includes('+')) return '+';
    if (flags.includes(' ')) return ' ';
  }
  return '';
}

function fmtFloatSpecial(n) {
  if (Number.isNaN(n)) return n < 0 ? 'nan' : 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  return null;
}

function fmtFixed(n, prec) {
  // JS toFixed switches to exponential for n >= 1e21, but C's %f expands fully.
  // Such doubles are integers, so expand the integer part exactly via BigInt and
  // pad the fraction with zeros. (n is already non-negative here.)
  if (n >= 1e21) {
    const intPart = BigInt(n).toString();
    return prec > 0 ? intPart + '.' + '0'.repeat(prec) : intPart;
  }
  // toFixed caps prec at 100; for larger precision pad with trailing zeros.
  if (prec > 100) return n.toFixed(100) + '0'.repeat(prec - 100);
  return n.toFixed(prec);
}

function fmtExp(n, prec, upper) {
  let s = n.toExponential(prec);
  s = s.replace(/e([+-])(\d)$/, 'e$10$2'); // at least 2 exponent digits
  return upper ? s.toUpperCase() : s;
}

function fmtG(n, prec, upper, alt) {
  if (prec === 0) prec = 1;
  const exp = n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n)));
  // use the exponent as printf computes it (from the rounded value)
  let s = n.toExponential(prec - 1);
  const e = parseInt(s.split('e')[1], 10);
  if (e < -4 || e >= prec) {
    let [mant, ex] = s.split('e');
    if (!alt && mant.indexOf('.') >= 0) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    const ae = Math.abs(e);
    s = `${mant}e${e < 0 ? '-' : '+'}${ae < 10 ? '0' + ae : ae}`;
  } else {
    s = n.toFixed(Math.max(0, prec - 1 - e));
    if (!alt && s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return upper ? s.toUpperCase() : s;
}

function quoteString(s) {
  const out = ['"'];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const cc = s.charCodeAt(i);
    if (c === '"' || c === '\\' || c === '\n') {
      out.push('\\', c);
    } else if (cc === 13) {
      out.push('\\r');
    } else if (cc === 0) {
      out.push('\\000'); // Lua 5.1 %q emits the zero byte as \000
    } else {
      out.push(c);
    }
  }
  out.push('"');
  return out.join('');
}

function* formatImpl(I, args) {
  const fmt = checkStr(args[0], 1, 'format');
  let argi = 1;
  const nextArg = (conv) => {
    if (argi >= args.length) {
      throw new LuaError(`bad argument #${argi + 1} to 'format' (no value)`);
    }
    return args[argi++];
  };
  const out = [];
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c !== '%') {
      out.push(c);
      i++;
      continue;
    }
    i++;
    if (fmt[i] === '%') {
      out.push('%');
      i++;
      continue;
    }
    // flags, width, precision
    let flags = '';
    while ('-+ #0'.includes(fmt[i])) flags += fmt[i++];
    let width = 0;
    while (fmt[i] >= '0' && fmt[i] <= '9') width = width * 10 + (fmt.charCodeAt(i++) - 48);
    let prec = -1;
    if (fmt[i] === '.') {
      i++;
      prec = 0;
      while (fmt[i] >= '0' && fmt[i] <= '9') prec = prec * 10 + (fmt.charCodeAt(i++) - 48);
    }
    const conv = fmt[i++];
    let piece;
    switch (conv) {
      case 'd': case 'i': {
        let n = Math.trunc(checkNum(nextArg(), argi, 'format'));
        let digits = Math.abs(n).toString();
        if (prec >= 0) digits = digits.padStart(prec, '0');
        piece = (n < 0 ? '-' : fmtSign(n, flags)) + digits;
        piece = fmtPad(piece, flags, width, prec < 0);
        break;
      }
      case 'u': {
        let n = Math.trunc(checkNum(nextArg(), argi, 'format'));
        if (n < 0) n += 4294967296;
        piece = fmtPad(n.toString(), flags, width, prec < 0);
        break;
      }
      case 'c': {
        const n = Math.trunc(checkNum(nextArg(), argi, 'format'));
        piece = fmtPad(String.fromCharCode(n), flags, width, false);
        break;
      }
      case 'x': case 'X': case 'o': {
        let n = Math.trunc(checkNum(nextArg(), argi, 'format'));
        if (n < 0) n += 4294967296;
        let digits = n.toString(conv === 'o' ? 8 : 16);
        if (conv === 'X') digits = digits.toUpperCase();
        if (prec >= 0) digits = digits.padStart(prec, '0');
        if (flags.includes('#') && n !== 0) {
          if (conv === 'x') digits = '0x' + digits;
          else if (conv === 'X') digits = '0X' + digits;
          else if (digits[0] !== '0') digits = '0' + digits;
        }
        piece = fmtPad(digits, flags, width, prec < 0);
        break;
      }
      case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': {
        const n = checkNum(nextArg(), argi, 'format');
        const special = fmtFloatSpecial(n);
        if (special !== null) {
          piece = fmtPad(special, flags, width, false);
          break;
        }
        const p = prec < 0 ? 6 : prec;
        let body;
        if (conv === 'f' || conv === 'F') body = fmtFixed(Math.abs(n), p);
        else if (conv === 'e' || conv === 'E') body = fmtExp(Math.abs(n), p, conv === 'E');
        else body = fmtG(Math.abs(n), p, conv === 'G', flags.includes('#'));
        piece = (n < 0 || Object.is(n, -0) ? '-' : fmtSign(n, flags)) + body;
        piece = fmtPad(piece, flags, width, true);
        break;
      }
      case 's': {
        let s = yield* tostringMM(nextArg());
        if (typeof s !== 'string') s = String(s);
        if (prec >= 0) s = s.slice(0, prec);
        piece = fmtPad(s, flags, width, false);
        break;
      }
      case 'q': {
        piece = quoteString(checkStr(nextArg(), argi, 'format'));
        break;
      }
      default:
        throw new LuaError(`invalid option '%${conv ?? ''}' to 'format'`);
    }
    out.push(piece);
  }
  return [out.join('')];
}

// ---------- gsub replacement ----------

function substCaptures(repl, s, m) {
  const caps = capturesOf(s, m);
  const whole = s.slice(m.start, m.end);
  const out = [];
  let i = 0;
  while (i < repl.length) {
    const c = repl[i];
    if (c !== '%') {
      out.push(c);
      i++;
      continue;
    }
    i++;
    const d = repl[i];
    if (d === '%') {
      out.push('%');
    } else if (d >= '0' && d <= '9') {
      if (d === '0') {
        out.push(whole);
      } else {
        const idx = d.charCodeAt(0) - 49;
        const cap = caps[idx];
        if (cap === undefined) throw new LuaError(`invalid capture index %${idx + 1}`);
        out.push(typeof cap === 'number' ? numberToString(cap) : cap);
      }
    } else {
      throw new LuaError("invalid use of '%' in replacement string");
    }
    i++;
  }
  return out.join('');
}

export default function install(I) {
  const lib = new LuaTable();
  const native = registrar(lib);

  native('len', function* (I, args) {
    return [checkStr(args[0], 1, 'len').length];
  });

  native('sub', function* (I, args) {
    const s = checkStr(args[0], 1, 'sub');
    const len = s.length;
    let i = posrelat(optNum(args[1], 1, 2, 'sub'), len);
    let j = posrelat(optNum(args[2], -1, 3, 'sub'), len);
    if (i < 1) i = 1;
    if (j > len) j = len;
    if (i > j) return [''];
    return [s.slice(i - 1, j)];
  });

  native('upper', function* (I, args) {
    return [checkStr(args[0], 1, 'upper').toUpperCase()];
  });

  native('lower', function* (I, args) {
    return [checkStr(args[0], 1, 'lower').toLowerCase()];
  });

  native('rep', function* (I, args) {
    const s = checkStr(args[0], 1, 'rep');
    const n = Math.trunc(checkNum(args[1], 2, 'rep'));
    if (n <= 0) return [''];
    const sep = args[2] === undefined ? '' : checkStr(args[2], 3, 'rep');
    if (sep === '') return [s.repeat(n)];
    return [new Array(n).fill(s).join(sep)];
  });

  native('reverse', function* (I, args) {
    return [[...checkStr(args[0], 1, 'reverse')].reverse().join('')];
  });

  native('byte', function* (I, args) {
    const s = checkStr(args[0], 1, 'byte');
    const len = s.length;
    let i = posrelat(optNum(args[1], 1, 2, 'byte'), len);
    let j = posrelat(optNum(args[2], i, 3, 'byte'), len);
    if (i < 1) i = 1;
    if (j > len) j = len;
    const out = [];
    for (let k = i; k <= j; k++) out.push(s.charCodeAt(k - 1));
    return out;
  });

  native('char', function* (I, args) {
    let out = '';
    for (let k = 0; k < args.length; k++) {
      out += String.fromCharCode(Math.trunc(checkNum(args[k], k + 1, 'char')));
    }
    return [out];
  });

  native('format', formatImpl);

  native('dump', function* (I, args) {
    const f = args[0];
    if (!(f instanceof LuaClosure)) {
      throw new LuaError("unable to dump given function");
    }
    // No real bytecode: serialize the AST prototype plus the names of the
    // function's upvalues (their values are NOT preserved, as in Lua 5.1).
    const upNames = closureUpvalues(f).map((u) => u.name);
    const payload = JSON.stringify({ proto: f.proto, upNames, chunkname: f.chunkname });
    return [DUMP_MAGIC + payload];
  });

  // ---------- pattern functions ----------

  function findInit(args, s, fname) {
    let init = posrelat(optNum(args[2], 1, 3, fname), s.length);
    if (init < 1) init = 1;
    else if (init > s.length + 1) init = s.length + 1;
    return init - 1; // 0-based
  }

  native('find', function* (I, args) {
    const s = checkStr(args[0], 1, 'find');
    const pat = checkStr(args[1], 2, 'find');
    const init = findInit(args, s, 'find');
    if (truthy(args[3])) {
      const at = s.indexOf(pat, init);
      return at < 0 ? [undefined] : [at + 1, at + pat.length];
    }
    const m = patMatch(s, pat, init);
    if (m === null) return [undefined];
    return [m.start + 1, m.end, ...m.captures];
  });

  native('match', function* (I, args) {
    const s = checkStr(args[0], 1, 'match');
    const pat = checkStr(args[1], 2, 'match');
    const init = findInit(args, s, 'match');
    const m = patMatch(s, pat, init);
    if (m === null) return [undefined];
    return capturesOf(s, m);
  });

  native('gmatch', function* (I, args) {
    const s = checkStr(args[0], 1, 'gmatch');
    let pat = checkStr(args[1], 2, 'gmatch');
    if (pat[0] === '^') pat = '%' + pat; // 5.1: '^' is literal in gmatch
    let pos = 0;
    return [new NativeFunction('gmatch_iter', function* () {
      while (pos <= s.length) {
        const m = patMatch(s, pat, pos);
        if (m === null) return [undefined];
        pos = m.end > m.start ? m.end : m.start + 1;
        return capturesOf(s, m);
      }
      return [undefined];
    })];
  });

  native('gsub', function* (I, args) {
    const s = checkStr(args[0], 1, 'gsub');
    const pat = checkStr(args[1], 2, 'gsub');
    const repl = args[2];
    const maxN = args[3] === undefined ? Infinity : checkNum(args[3], 4, 'gsub');
    const replType = typeName(repl);
    if (replType !== 'string' && replType !== 'number' &&
        replType !== 'table' && replType !== 'function') {
      throw new LuaError(`bad argument #3 to 'gsub' (string/function/table expected)`);
    }
    const out = [];
    let pos = 0;
    let count = 0;
    while (count < maxN) {
      const m = patMatch(s, pat, pos);
      if (m === null || m.start > s.length) break;
      // anchored patterns only match at the current position scan start;
      // patMatch already walks forward, so emit the skipped prefix:
      out.push(s.slice(pos, m.start));
      count++;
      const whole = s.slice(m.start, m.end);
      let value;
      if (replType === 'string' || replType === 'number') {
        value = substCaptures(typeof repl === 'number' ? numberToString(repl) : repl, s, m);
      } else if (replType === 'table') {
        value = yield* index(repl, capturesOf(s, m)[0]); // respects __index
      } else {
        value = (yield* callValue(repl, capturesOf(s, m)))[0];
      }
      if (value === undefined || value === false) {
        out.push(whole);
      } else if (typeof value === 'string') {
        out.push(value);
      } else if (typeof value === 'number') {
        out.push(numberToString(value));
      } else {
        throw new LuaError(`invalid replacement value (a ${typeName(value)})`);
      }
      if (m.end > m.start) {
        pos = m.end;
      } else {
        if (m.start < s.length) out.push(s[m.start]);
        pos = m.start + 1;
      }
      if (pat[0] === '^') break; // anchored: single attempt at the start
    }
    out.push(s.slice(Math.min(pos, s.length)));
    return [out.join(''), count];
  });

  lib.set('gfind', lib.get('gmatch')); // Lua 5.1 deprecated alias

  I.globals.set('string', lib);
  setStringLibrary(lib);
}
