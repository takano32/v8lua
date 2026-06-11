// base.js — the Lua base library.
import fs from 'node:fs';
import {
  LuaError, LuaTable, NativeFunction, LuaClosure,
  callValue, tostringMM, typeName, truthy, getMetatable,
  luaToNumber, numberToString, luaToDisplayString,
} from '../runtime.js';

function checkTable(v, n, fname) {
  if (!(v instanceof LuaTable)) {
    throw new LuaError(`bad argument #${n} to '${fname}' (table expected, got ${typeName(v)})`);
  }
  return v;
}

export default function install(I) {
  const G = I.globals;
  const native = (name, fn) => G.set(name, new NativeFunction(name, fn));

  native('print', function* (I, args) {
    const parts = [];
    for (const v of args) parts.push(yield* tostringMM(v));
    I.stdout(parts.join('\t') + '\n');
    return [];
  });

  native('type', function* (I, args) {
    if (args.length === 0) throw new LuaError(`bad argument #1 to 'type' (value expected)`);
    return [typeName(args[0])];
  });

  native('tostring', function* (I, args) {
    if (args.length === 0) throw new LuaError(`bad argument #1 to 'tostring' (value expected)`);
    return [yield* tostringMM(args[0])];
  });

  native('tonumber', function* (I, args) {
    const [v, baseArg] = args;
    if (baseArg === undefined) return [luaToNumber(v)];
    const base = luaToNumber(baseArg);
    if (base === undefined) {
      throw new LuaError(`bad argument #2 to 'tonumber' (number expected, got ${typeName(baseArg)})`);
    }
    if (base === 10) return [luaToNumber(v)];
    if (typeof v !== 'string') {
      throw new LuaError(`bad argument #1 to 'tonumber' (string expected, got ${typeName(v)})`);
    }
    return [luaToNumber(v, base)];
  });

  const nextFn = new NativeFunction('next', function* (I, args) {
    const t = checkTable(args[0], 1, 'next');
    const pair = t.next(args[1]);
    return pair === null ? [undefined] : pair;
  });
  G.set('next', nextFn);

  native('pairs', function* (I, args) {
    checkTable(args[0], 1, 'pairs');
    return [nextFn, args[0], undefined];
  });

  const ipairsIter = new NativeFunction('ipairs_iter', function* (I, args) {
    const t = args[0];
    const i = args[1] + 1;
    const v = t.get(i);
    return v === undefined ? [undefined] : [i, v];
  });
  native('ipairs', function* (I, args) {
    checkTable(args[0], 1, 'ipairs');
    return [ipairsIter, args[0], 0];
  });

  native('select', function* (I, args) {
    const n = args[0];
    const rest = args.slice(1);
    if (n === '#') return [rest.length];
    const i = luaToNumber(n);
    if (i === undefined) {
      throw new LuaError(`bad argument #1 to 'select' (number expected, got ${typeName(n)})`);
    }
    if (i < 0) {
      const at = rest.length + i;
      if (at < 0) throw new LuaError(`bad argument #1 to 'select' (index out of range)`);
      return rest.slice(at);
    }
    if (i === 0) throw new LuaError(`bad argument #1 to 'select' (index out of range)`);
    return rest.slice(i - 1);
  });

  native('rawget', function* (I, args) {
    const t = checkTable(args[0], 1, 'rawget');
    return [t.get(args[1])];
  });

  native('rawset', function* (I, args) {
    const t = checkTable(args[0], 1, 'rawset');
    t.set(args[1], args[2]);
    return [t];
  });

  native('rawequal', function* (I, args) {
    return [args[0] === args[1]];
  });

  native('rawlen', function* (I, args) {
    const v = args[0];
    if (v instanceof LuaTable) return [v.len()];
    if (typeof v === 'string') return [v.length];
    throw new LuaError(`table or string expected`);
  });

  native('setmetatable', function* (I, args) {
    const t = checkTable(args[0], 1, 'setmetatable');
    const mt = args[1];
    if (mt !== undefined && !(mt instanceof LuaTable)) {
      throw new LuaError(`bad argument #2 to 'setmetatable' (nil or table expected)`);
    }
    if (t.metatable !== undefined && t.metatable.get('__metatable') !== undefined) {
      throw new LuaError('cannot change a protected metatable');
    }
    t.metatable = mt;
    return [t];
  });

  native('getmetatable', function* (I, args) {
    const mt = getMetatable(args[0]);
    if (mt === undefined) return [undefined];
    const protect = mt.get('__metatable');
    return [protect !== undefined ? protect : mt];
  });

  native('assert', function* (I, args) {
    if (truthy(args[0])) return args;
    const msg = args.length >= 2 ? args[1] : 'assertion failed!';
    const e = new LuaError(msg);
    e.positioned = true; // assert does not add position info (Lua 5.1)
    throw e;
  });

  native('error', function* (I, args) {
    let msg = args[0];
    const level = args[1] === undefined ? 1 : luaToNumber(args[1]);
    // numbers count as strings here (Lua coerces), and gain position info too
    if (typeof msg === 'number') msg = numberToString(msg);
    if (typeof msg === 'string' && level > 0) {
      msg = `${I.chunkname}:${I.currentLine}: ${msg}`;
    }
    const e = new LuaError(msg);
    e.positioned = true;
    throw e;
  });

  native('pcall', function* (I, args) {
    const f = args[0];
    try {
      const vals = yield* callValue(f, args.slice(1));
      return [true, ...vals];
    } catch (e) {
      if (e instanceof LuaError) return [false, e.luaMessage];
      if (e instanceof RangeError) return [false, 'stack overflow'];
      throw e;
    }
  });

  native('xpcall', function* (I, args) {
    const [f, handler] = args;
    try {
      const vals = yield* callValue(f, args.slice(2));
      return [true, ...vals];
    } catch (e) {
      let msg;
      if (e instanceof LuaError) msg = e.luaMessage;
      else if (e instanceof RangeError) msg = 'stack overflow';
      else throw e;
      const hvals = yield* callValue(handler, [msg]);
      return [false, ...hvals];
    }
  });

  const unpackFn = new NativeFunction('unpack', function* (I, args) {
    const t = checkTable(args[0], 1, 'unpack');
    const i = args[1] === undefined ? 1 : luaToNumber(args[1]);
    const j = args[2] === undefined ? t.len() : luaToNumber(args[2]);
    const out = [];
    for (let k = i; k <= j; k++) out.push(t.get(k));
    return out;
  });
  G.set('unpack', unpackFn);

  native('collectgarbage', function* (I, args) {
    return args[0] === 'count' ? [0, 0] : [0];
  });

  function compileChunk(source, chunkname) {
    try {
      return [I.compile(source, chunkname)];
    } catch (e) {
      if (e instanceof LuaError) return [undefined, e.luaMessage];
      throw e;
    }
  }

  const loadFn = new NativeFunction('load', function* (I, args) {
    let [chunk, chunkname] = args;
    if (typeof chunk === 'string') {
      return compileChunk(chunk, typeof chunkname === 'string' ? chunkname : chunk);
    }
    if (typeName(chunk) === 'function') {
      const parts = [];
      for (;;) {
        const piece = (yield* callValue(chunk, []))[0];
        if (piece === undefined || piece === '') break;
        if (typeof piece !== 'string') return [undefined, 'reader function must return a string'];
        parts.push(piece);
      }
      return compileChunk(parts.join(''), typeof chunkname === 'string' ? chunkname : '=(load)');
    }
    throw new LuaError(`bad argument #1 to 'load' (function expected, got ${typeName(chunk)})`);
  });
  G.set('load', loadFn);
  G.set('loadstring', loadFn);

  native('loadfile', function* (I, args) {
    const path = args[0];
    let source;
    try {
      source = fs.readFileSync(path, 'utf8');
    } catch (e) {
      return [undefined, `cannot open ${path}`];
    }
    return compileChunk(source.replace(/^#![^\n]*/, ''), '@' + path);
  });

  native('dofile', function* (I, args) {
    const path = args[0];
    let source;
    try {
      source = fs.readFileSync(path, 'utf8');
    } catch (e) {
      throw new LuaError(`cannot open ${path}`);
    }
    const closure = I.compile(source.replace(/^#![^\n]*/, ''), '@' + path);
    return yield* callValue(closure, []);
  });

  G.set('_VERSION', 'Lua 5.1');
}
