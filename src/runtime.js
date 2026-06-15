// runtime.js — Lua value model, LuaTable, errors, and metamethod-aware operations.
// See docs/SPEC.md "src/runtime.js — exact exports" for the binding contract.

export const YIELD = Symbol('yield');

let nextObjectId = 1;
const objectIds = new WeakMap();
function idOf(obj) {
  let id = objectIds.get(obj);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(obj, id);
  }
  return id;
}

export class LuaError extends Error {
  constructor(luaMessage) {
    super(typeof luaMessage === 'string' ? luaMessage : '(error object is not a string)');
    this.luaMessage = luaMessage;
    this.positioned = false;
  }
}

function normKey(k) {
  if (typeof k === 'number' && Object.is(k, -0)) return 0;
  return k;
}

export class LuaTable {
  constructor() {
    this.hash = new Map();
    this.metatable = undefined;
    this._iter = null; // snapshot cache for next()
  }

  get(k) {
    k = normKey(k);
    if (k === undefined || (typeof k === 'number' && Number.isNaN(k))) return undefined;
    return this.hash.get(k);
  }

  set(k, v) {
    k = normKey(k);
    if (k === undefined) throw new LuaError('table index is nil');
    if (typeof k === 'number' && Number.isNaN(k)) throw new LuaError('table index is NaN');
    if (v === undefined) this.hash.delete(k);
    else this.hash.set(k, v);
  }

  // '#' border search: some n with t[n] ~= nil and t[n+1] == nil (0 if t[1] == nil).
  len() {
    if (this.hash.get(1) === undefined) return 0;
    let i = 1;
    let j = 2;
    while (this.hash.get(j) !== undefined) {
      i = j;
      j *= 2;
      if (j > 2147483647) {
        let n = i;
        while (this.hash.get(n + 1) !== undefined) n++;
        return n;
      }
    }
    while (j - i > 1) {
      const m = Math.floor((i + j) / 2);
      if (this.hash.get(m) !== undefined) i = m;
      else j = m;
    }
    return i;
  }

  // Iteration for next/pairs: snapshot of keys, tolerant of deletions during
  // traversal (deleted keys are skipped). next(undefined) starts; returns
  // [key, value] or null at the end.
  next(k) {
    k = normKey(k);
    if (k === undefined) {
      this._iter = { keys: [...this.hash.keys()], idx: 0 };
      return this._advance();
    }
    if (!this._iter || this._iter.lastKey !== k) {
      const keys = [...this.hash.keys()];
      const at = keys.findIndex((x) => x === k || (Number.isNaN(x) && Number.isNaN(k)));
      if (at < 0) throw new LuaError("invalid key to 'next'");
      this._iter = { keys, idx: at + 1 };
    }
    return this._advance();
  }

  _advance() {
    const it = this._iter;
    while (it.idx < it.keys.length) {
      const key = it.keys[it.idx++];
      if (this.hash.has(key)) {
        it.lastKey = key;
        return [key, this.hash.get(key)];
      }
    }
    this._iter = null;
    return null;
  }
}

export class NativeFunction {
  // fn: function*(I, args) -> LuaValue[]
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
  }
}

export class LuaClosure {
  constructor(proto, scope, name, interp) {
    this.proto = proto;   // FuncExpr AST node
    this.scope = scope;   // defining Scope
    this.name = name || null;
    this.interp = interp;
  }
}

export class LuaCoroutine {
  constructor(fn) {
    this.fn = fn;
    this.status = 'suspended';
    this.it = null;
    this.started = false;
  }
}

// Full userdata: an opaque value with a metatable. Used for io file handles and
// newproxy. `data` holds the JS-side payload (e.g. a file handle record).
export class LuaUserdata {
  constructor(data) {
    this.data = data;
    this.metatable = undefined;
  }
}

// --- dependency injection (set by interp / string lib) ---
let closureCall = null;
let stringLibrary = null;
let stringMetatable = undefined;
let currentInterp = null;

export function setClosureCall(genFn) { closureCall = genFn; }
export function setStringLibrary(tbl) {
  stringLibrary = tbl;
  stringMetatable = new LuaTable();
  stringMetatable.set('__index', tbl);
}

// Per-basic-type metatables (Lua's lua_setmetatable for non-table types, set
// via debug.setmetatable). Strings keep their library metatable separately.
const typeMetatables = Object.create(null);
export function setTypeMetatable(tname, mt) {
  if (tname === 'string') stringMetatable = mt;
  else typeMetatables[tname] = mt;
}
export function setCurrentInterp(I) { currentInterp = I; }
export function getCurrentInterp() { return currentInterp; }

// --- plain helpers ---

export function truthy(v) { return v !== undefined && v !== false; }

export function typeName(v) {
  if (v === undefined) return 'nil';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (v instanceof LuaTable) return 'table';
  if (v instanceof LuaClosure || v instanceof NativeFunction) return 'function';
  if (v instanceof LuaCoroutine) return 'thread';
  return 'userdata';
}

export function getMetatable(v) {
  if (v instanceof LuaTable) return v.metatable;
  if (v instanceof LuaUserdata) return v.metatable;
  if (typeof v === 'string') return stringMetatable;
  return typeMetatables[typeName(v)];
}

function metamethod(v, name) {
  const mt = getMetatable(v);
  return mt === undefined ? undefined : mt.get(name);
}

// Parse the body of a Lua numeric constant (no sign): decimal or hex (with
// optional hex fraction/binary exponent). Returns number | undefined.
// Shared by the lexer (number literals) and luaToNumber (tonumber/coercion).
export function parseNumberBody(text) {
  if (text.length === 0) return undefined;
  if (text[0] === '0' && (text[1] === 'x' || text[1] === 'X')) {
    const m = /^([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?$/.exec(text.slice(2));
    if (!m) return undefined;
    const [, intPart, fracPart, expPart] = m;
    if (intPart.length === 0 && (fracPart === undefined || fracPart.length === 0)) return undefined;
    let v = intPart.length > 0 ? parseInt(intPart, 16) : 0;
    if (fracPart !== undefined && fracPart.length > 0) {
      let scale = 1 / 16;
      for (let i = 0; i < fracPart.length; i++) {
        v += parseInt(fracPart[i], 16) * scale;
        scale /= 16;
      }
    }
    if (expPart !== undefined) v *= Math.pow(2, parseInt(expPart, 10));
    return v;
  }
  if (!/^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) return undefined;
  return parseFloat(text);
}

export function luaToNumber(v, base) {
  if (typeof v === 'number') return base === undefined ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (base === undefined || base === 10) {
    let body = s;
    let sign = 1;
    if (body[0] === '+' || body[0] === '-') {
      if (body[0] === '-') sign = -1;
      body = body.slice(1);
    }
    const n = parseNumberBody(body);
    return n === undefined ? undefined : sign * n;
  }
  if (!(base >= 2 && base <= 36)) return undefined;
  let body = s.toLowerCase();
  let sign = 1;
  if (body[0] === '+' || body[0] === '-') {
    if (body[0] === '-') sign = -1;
    body = body.slice(1);
  }
  if (base === 16 && body.startsWith('0x')) body = body.slice(2);
  if (body.length === 0) return undefined;
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    let d;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 122) d = c - 87;
    else return undefined;
    if (d >= base) return undefined;
    n = n * base + d;
  }
  return sign * n;
}

// Lua's %.14g number formatting.
export function numberToString(n) {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (Object.is(n, -0)) return '-0';
  const prec = 14;
  const expStr = n.toExponential(prec - 1);
  let [mant, exp] = expStr.split('e');
  const e = parseInt(exp, 10);
  if (e < -4 || e >= prec) {
    if (mant.indexOf('.') >= 0) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    const ae = Math.abs(e);
    return `${mant}e${e < 0 ? '-' : '+'}${ae < 10 ? '0' + ae : ae}`;
  }
  let fixed = n.toFixed(Math.max(0, prec - 1 - e));
  if (fixed.indexOf('.') >= 0) fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return fixed;
}

// Lua's luaO_chunkid: turn a chunk source name into the short form used in
// error messages and debug.getinfo's short_src. '=x' -> 'x' (verbatim),
// '@file' -> 'file' (front-truncated if long), otherwise '[string "first line"]'.
const ID_SIZE = 60;
export function shortSrc(source) {
  if (typeof source !== 'string') source = String(source);
  if (source[0] === '=') return source.slice(1, ID_SIZE);
  if (source[0] === '@') {
    const s = source.slice(1);
    if (s.length <= ID_SIZE - 1) return s;
    return '...' + s.slice(s.length - (ID_SIZE - 4));
  }
  const max = ID_SIZE - 16; // leave room for the [string "..."] wrapper
  const nl = source.indexOf('\n');
  let s = source;
  let trunc = false;
  if (nl >= 0) { s = source.slice(0, nl); trunc = true; }
  if (s.length > max) { s = s.slice(0, max); trunc = true; }
  return `[string "${s}${trunc ? '...' : ''}"]`;
}

export function luaToDisplayString(v) {
  if (v === undefined || v === null) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return numberToString(v);
  if (typeof v === 'string') return v;
  const addr = '0x' + idOf(v).toString(16).padStart(8, '0');
  if (v instanceof LuaTable) return 'table: ' + addr;
  if (v instanceof LuaClosure || v instanceof NativeFunction) return 'function: ' + addr;
  if (v instanceof LuaCoroutine) return 'thread: ' + addr;
  return 'userdata: ' + addr;
}

// Drive a runtime generator to completion in a non-coroutine context.
// A bare YIELD bubbling out here means coroutine.yield was called with no
// coroutine on the stack.
export function runToCompletion(gen) {
  let r = gen.next();
  while (!r.done) {
    if (r.value && r.value[YIELD]) {
      throw new LuaError('attempt to yield from outside a coroutine');
    }
    r = gen.next();
  }
  return r.value;
}

// --- metamethod-aware operations (generators: metamethods may yield) ---

export function* callValue(f, args) {
  for (let depth = 0; depth < 100; depth++) {
    if (f instanceof LuaClosure) return yield* closureCall(f, args);
    if (f instanceof NativeFunction) {
      const I = currentInterp;
      // Fire call/return debug hooks for C functions too. The frame is pushed
      // only around the hook (so getinfo(2) in the hook sees this native), then
      // popped so the native body runs frameless and level math stays correct.
      if (I !== null && I.hook !== null && (I.hook.call || I.hook.ret)) {
        if (I.hook.call) {
          I.frames.push({ closure: f, line: -1 });
          try { yield* I.fireHook('call'); } finally { I.frames.pop(); }
        }
        const r = yield* f.fn(I, args);
        if (I.hook !== null && I.hook.ret) {
          I.frames.push({ closure: f, line: -1 });
          try { yield* I.fireHook('return'); } finally { I.frames.pop(); }
        }
        return r === undefined ? [] : r;
      }
      const r = yield* f.fn(currentInterp, args);
      return r === undefined ? [] : r;
    }
    const h = metamethod(f, '__call');
    if (h !== undefined) {
      args = [f, ...args];
      f = h;
      continue;
    }
    throw new LuaError(`attempt to call a ${typeName(f)} value`);
  }
  throw new LuaError("'__call' chain too long; possible loop");
}

export function* index(obj, key) {
  for (let depth = 0; depth < 100; depth++) {
    if (obj instanceof LuaTable) {
      const v = obj.get(key);
      if (v !== undefined) return v;
      const h = obj.metatable === undefined ? undefined : obj.metatable.get('__index');
      if (h === undefined) return undefined;
      if (h instanceof LuaClosure || h instanceof NativeFunction) {
        return (yield* callValue(h, [obj, key]))[0];
      }
      obj = h;
      continue;
    }
    if (typeof obj === 'string') {
      return stringLibrary === null ? undefined : stringLibrary.get(key);
    }
    const h = metamethod(obj, '__index');
    if (h === undefined) {
      throw new LuaError(`attempt to index a ${typeName(obj)} value`);
    }
    if (h instanceof LuaClosure || h instanceof NativeFunction) {
      return (yield* callValue(h, [obj, key]))[0];
    }
    obj = h;
  }
  throw new LuaError("'__index' chain too long; possible loop");
}

export function* newindex(obj, key, val) {
  for (let depth = 0; depth < 100; depth++) {
    if (obj instanceof LuaTable) {
      if (obj.get(key) !== undefined) {
        obj.set(key, val);
        return;
      }
      const h = obj.metatable === undefined ? undefined : obj.metatable.get('__newindex');
      if (h === undefined) {
        obj.set(key, val);
        return;
      }
      if (h instanceof LuaClosure || h instanceof NativeFunction) {
        yield* callValue(h, [obj, key, val]);
        return;
      }
      obj = h;
      continue;
    }
    const h = metamethod(obj, '__newindex');
    if (h === undefined) {
      throw new LuaError(`attempt to index a ${typeName(obj)} value`);
    }
    if (h instanceof LuaClosure || h instanceof NativeFunction) {
      yield* callValue(h, [obj, key, val]);
      return;
    }
    obj = h;
  }
  throw new LuaError("'__newindex' chain too long; possible loop");
}

const ARITH_MM = {
  add: '__add', sub: '__sub', mul: '__mul', div: '__div',
  mod: '__mod', pow: '__pow', unm: '__unm',
};

function arithCoerce(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return luaToNumber(v);
  return undefined;
}

export function* arith(op, a, b) {
  const x = arithCoerce(a);
  const y = op === 'unm' ? x : arithCoerce(b);
  if (x !== undefined && y !== undefined) {
    switch (op) {
      case 'add': return x + y;
      case 'sub': return x - y;
      case 'mul': return x * y;
      case 'div': return x / y;
      case 'mod': return x - Math.floor(x / y) * y;
      case 'pow': return Math.pow(x, y);
      case 'unm': return -x;
    }
  }
  const other = op === 'unm' ? a : b;
  const h = metamethod(a, ARITH_MM[op]) ?? metamethod(other, ARITH_MM[op]);
  if (h !== undefined) {
    return (yield* callValue(h, [a, other]))[0];
  }
  const bad = x === undefined ? a : other;
  throw new LuaError(`attempt to perform arithmetic on a ${typeName(bad)} value`);
}

// Lua 5.1: order/equality metamethods require both operands to share the
// SAME handler (lvm.c get_compTM / call_orderTM).
function sharedHandler(a, b, name) {
  const h1 = metamethod(a, name);
  if (h1 === undefined) return undefined;
  const h2 = metamethod(b, name);
  return h1 === h2 ? h1 : undefined;
}

export function* compare(op, a, b) {
  if (op === 'eq') {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return false; // NaN, -0 handled by ===/norm
    if (a instanceof LuaTable && b instanceof LuaTable) {
      const h = sharedHandler(a, b, '__eq');
      if (h !== undefined) return truthy((yield* callValue(h, [a, b]))[0]);
    }
    return false;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return op === 'lt' ? a < b : a <= b;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return op === 'lt' ? a < b : a <= b;
  }
  if (op === 'lt') {
    const h = sharedHandler(a, b, '__lt');
    if (h !== undefined) return truthy((yield* callValue(h, [a, b]))[0]);
  } else {
    const h = sharedHandler(a, b, '__le');
    if (h !== undefined) return truthy((yield* callValue(h, [a, b]))[0]);
    const hlt = sharedHandler(a, b, '__lt');
    if (hlt !== undefined) return !truthy((yield* callValue(hlt, [b, a]))[0]);
  }
  const ta = typeName(a);
  const tb = typeName(b);
  if (ta === tb) throw new LuaError(`attempt to compare two ${ta} values`);
  throw new LuaError(`attempt to compare ${ta} with ${tb}`);
}

export function* concat(a, b) {
  const aOk = typeof a === 'string' || typeof a === 'number';
  const bOk = typeof b === 'string' || typeof b === 'number';
  if (aOk && bOk) {
    const sa = typeof a === 'number' ? numberToString(a) : a;
    const sb = typeof b === 'number' ? numberToString(b) : b;
    return sa + sb;
  }
  const h = metamethod(a, '__concat') ?? metamethod(b, '__concat');
  if (h !== undefined) {
    return (yield* callValue(h, [a, b]))[0];
  }
  const bad = aOk ? b : a;
  throw new LuaError(`attempt to concatenate a ${typeName(bad)} value`);
}

export function* len(v) {
  if (typeof v === 'string') return v.length;
  // Lua 5.1 / LuaJIT: '#' on tables does NOT consult __len.
  if (v instanceof LuaTable) return v.len();
  throw new LuaError(`attempt to get length of a ${typeName(v)} value`);
}

export function* tostringMM(v) {
  const h = metamethod(v, '__tostring');
  if (h !== undefined) {
    // Lua 5.1: tostring() returns the __tostring result as-is (numbers coerced
    // to strings). It does NOT require a string — only print does (handled there).
    const r = (yield* callValue(h, [v]))[0];
    return typeof r === 'number' ? numberToString(r) : r;
  }
  return luaToDisplayString(v);
}
