// lexer.js — tokenizer: Lua 5.1 (+goto) source -> tokens per SPEC.md "Token
// format". Produces tokens lazily on demand so a `load` reader function is
// pulled only as far as parsing needs (matching Lua's incremental loading).
import { LuaError, parseNumberBody, shortSrc } from './runtime.js';

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while',
]);

function isDigit(c) { return c >= '0' && c <= '9'; }
function isHexDigit(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
function isAlpha(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isAlnum(c) { return isAlpha(c) || isDigit(c); }

// Character source over a string or a Lua reader function. For a reader, bytes
// are pulled (synchronously) only when an index is first accessed.
function makeSrc(input) {
  if (typeof input === 'string') {
    return {
      at: (i) => (i >= 0 && i < input.length) ? input[i] : undefined,
      slice: (a, b) => input.slice(a, b),
    };
  }
  // input is a JS reader: () => next piece (string), or undefined/'' at EOF.
  let buf = '';
  let done = false;
  const fill = (i) => {
    while (!done && buf.length <= i) {
      const s = input();
      if (s === undefined || s === '') { done = true; break; }
      if (typeof s !== 'string') throw new LuaError('reader function must return a string');
      buf += s;
    }
  };
  return {
    at: (i) => { if (i < 0) return undefined; fill(i); return i < buf.length ? buf[i] : undefined; },
    slice: (a, b) => { fill(b - 1); return buf.slice(a, b); },
  };
}

// Create a lazy tokenizer. Returns { token(i) } where token(i) yields the i-th
// token, lexing as needed; indices past EOF return the eof token.
export function createLexer(input, chunkname) {
  const src = makeSrc(input);
  let pos = 0;
  let line = 1;

  function lexError(msg, errLine) {
    const e = new LuaError(`${shortSrc(chunkname)}:${errLine === undefined ? line : errLine}: ${msg}`);
    e.positioned = true;
    throw e;
  }

  function skipNewline() {
    const c = src.at(pos);
    pos++;
    const d = src.at(pos);
    if ((d === '\n' || d === '\r') && d !== c) pos++;
    line++;
  }

  function tryLongBracket() {
    let p = pos + 1;
    let level = 0;
    while (src.at(p) === '=') { level++; p++; }
    if (src.at(p) === '[') {
      pos = p + 1;
      return level;
    }
    return -1;
  }

  function readLongBody(level, what) {
    const startLine = line;
    if (src.at(pos) === '\n' || src.at(pos) === '\r') skipNewline();
    const parts = [];
    let chunkStart = pos;
    for (;;) {
      if (src.at(pos) === undefined) {
        lexError(`unfinished long ${what} near '<eof>'`, startLine);
      }
      const c = src.at(pos);
      if (c === ']') {
        let p = pos + 1;
        let lv = 0;
        while (src.at(p) === '=') { lv++; p++; }
        if (lv === level && src.at(p) === ']') {
          parts.push(src.slice(chunkStart, pos));
          pos = p + 1;
          return parts.join('');
        }
        pos++;
      } else if (c === '\n' || c === '\r') {
        parts.push(src.slice(chunkStart, pos));
        skipNewline();
        parts.push('\n');
        chunkStart = pos;
      } else {
        pos++;
      }
    }
  }

  function readShortString(quote) {
    const startLine = line;
    pos++; // skip opening quote
    const parts = [];
    let chunkStart = pos;
    for (;;) {
      if (src.at(pos) === undefined) {
        lexError(`unfinished string near '<eof>'`, startLine);
      }
      const c = src.at(pos);
      if (c === quote) {
        parts.push(src.slice(chunkStart, pos));
        pos++;
        return parts.join('');
      }
      if (c === '\n' || c === '\r') {
        lexError(`unfinished string near '${parts.join('') + src.slice(chunkStart, pos)}'`, startLine);
      }
      if (c !== '\\') {
        pos++;
        continue;
      }
      parts.push(src.slice(chunkStart, pos));
      pos++; // skip backslash
      if (src.at(pos) === undefined) {
        lexError(`unfinished string near '<eof>'`, startLine);
      }
      const e = src.at(pos);
      switch (e) {
        case 'a': parts.push('\x07'); pos++; break;
        case 'b': parts.push('\b'); pos++; break;
        case 'f': parts.push('\f'); pos++; break;
        case 'n': parts.push('\n'); pos++; break;
        case 'r': parts.push('\r'); pos++; break;
        case 't': parts.push('\t'); pos++; break;
        case 'v': parts.push('\v'); pos++; break;
        case '\\': parts.push('\\'); pos++; break;
        case '"': parts.push('"'); pos++; break;
        case "'": parts.push("'"); pos++; break;
        case '\n': case '\r':
          skipNewline();
          parts.push('\n');
          break;
        case 'x': {
          pos++;
          let hex = '';
          for (let i = 0; i < 2; i++) {
            const h = src.at(pos);
            if (h === undefined || !isHexDigit(h)) {
              lexError(`hexadecimal digit expected near '\\x${hex}'`);
            }
            hex += h;
            pos++;
          }
          parts.push(String.fromCharCode(parseInt(hex, 16)));
          break;
        }
        case 'z': {
          pos++;
          for (;;) {
            const s = src.at(pos);
            if (s === undefined) break;
            if (s === '\n' || s === '\r') skipNewline();
            else if (s === ' ' || s === '\t' || s === '\v' || s === '\f') pos++;
            else break;
          }
          break;
        }
        default: {
          if (isDigit(e)) {
            let num = 0;
            let i = 0;
            while (i < 3 && src.at(pos) !== undefined && isDigit(src.at(pos))) {
              num = num * 10 + (src.at(pos).charCodeAt(0) - 48);
              pos++;
              i++;
            }
            if (num > 255) {
              lexError(`decimal escape too large near '\\${num}'`);
            }
            parts.push(String.fromCharCode(num));
          } else {
            lexError(`invalid escape sequence near '\\${e}'`);
          }
          break;
        }
      }
      chunkStart = pos;
    }
  }

  function readNumber() {
    const start = pos;
    const isHex = src.at(pos) === '0' && (src.at(pos + 1) === 'x' || src.at(pos + 1) === 'X');
    for (;;) {
      const c = src.at(pos);
      if (c === undefined) break;
      if (isAlnum(c) || c === '.') {
        pos++;
        continue;
      }
      if (c === '+' || c === '-') {
        const prev = src.at(pos - 1);
        if ((isHex && (prev === 'p' || prev === 'P')) ||
            (!isHex && (prev === 'e' || prev === 'E'))) {
          pos++;
          continue;
        }
      }
      break;
    }
    const text = src.slice(start, pos);
    const value = parseNumberBody(text);
    if (value === undefined) {
      lexError(`malformed number near '${text}'`);
    }
    return value;
  }

  function lexOneRaw() {
    // skip whitespace and comments
    for (;;) {
      const c = src.at(pos);
      if (c === undefined) break;
      if (c === '\n' || c === '\r') {
        skipNewline();
      } else if (c === ' ' || c === '\t' || c === '\v' || c === '\f') {
        pos++;
      } else if (c === '-' && src.at(pos + 1) === '-') {
        pos += 2;
        if (src.at(pos) === '[') {
          const level = tryLongBracket();
          if (level >= 0) { readLongBody(level, 'comment'); continue; }
        }
        while (src.at(pos) !== undefined && src.at(pos) !== '\n' && src.at(pos) !== '\r') pos++;
      } else {
        break;
      }
    }

    if (src.at(pos) === undefined) return { type: 'eof', value: '<eof>', line };

    const tokLine = line;
    const c = src.at(pos);

    if (isAlpha(c)) {
      const start = pos;
      while (src.at(pos) !== undefined && isAlnum(src.at(pos))) pos++;
      const word = src.slice(start, pos);
      return { type: KEYWORDS.has(word) ? 'keyword' : 'name', value: word, line: tokLine };
    }

    if (isDigit(c) || (c === '.' && isDigit(src.at(pos + 1)))) {
      const start = pos;
      const value = readNumber();
      return { type: 'number', value, text: src.slice(start, pos), line: tokLine };
    }

    if (c === '"' || c === "'") {
      const start = pos;
      const value = readShortString(c);
      return { type: 'string', value, text: src.slice(start, pos), line: tokLine };
    }

    if (c === '[') {
      const start = pos;
      const level = tryLongBracket();
      if (level >= 0) {
        const value = readLongBody(level, 'string');
        return { type: 'string', value, text: src.slice(start, pos), line: tokLine };
      }
      if (src.at(pos + 1) === '=') {
        lexError(`invalid long string delimiter near '${src.slice(pos, pos + 2)}'`);
      }
      pos++;
      return { type: 'op', value: '[', line: tokLine };
    }

    // operators, longest match first
    if (c === '.' && src.at(pos + 1) === '.' && src.at(pos + 2) === '.') {
      pos += 3;
      return { type: 'op', value: '...', line: tokLine };
    }
    const d = src.at(pos + 1);
    const two = c + (d === undefined ? '' : d);
    if (two === '..' || two === '==' || two === '~=' || two === '<=' ||
        two === '>=' || two === '::') {
      pos += 2;
      return { type: 'op', value: two, line: tokLine };
    }
    if ('.<>=(){}];:,+-*/%^#'.indexOf(c) >= 0) {
      pos++;
      return { type: 'op', value: c, line: tokLine };
    }

    lexError(`unexpected symbol near '${c}'`);
  }

  // Like Lua's lexer, keep one character of lookahead live past each token so a
  // reader is pulled the same number of times Lua would pull it.
  function lexOne() {
    const t = lexOneRaw();
    if (t.type !== 'eof') src.at(pos);
    return t;
  }

  const cache = [];
  let eofIndex = -1;
  function token(i) {
    while (eofIndex < 0 && cache.length <= i) {
      const t = lexOne();
      cache.push(t);
      if (t.type === 'eof') eofIndex = cache.length - 1;
    }
    if (eofIndex >= 0 && i > eofIndex) return cache[eofIndex];
    return cache[i];
  }

  return { token };
}

// Eagerly tokenize a string into an array (kept for compatibility/tools).
export function tokenize(source, chunkname) {
  const lx = createLexer(source, chunkname);
  const out = [];
  for (let i = 0; ; i++) {
    const t = lx.token(i);
    out.push(t);
    if (t.type === 'eof') return out;
  }
}
