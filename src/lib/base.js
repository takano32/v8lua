// base.js — the Lua base library.
import fs from 'node:fs';
import {
  LuaError, LuaTable, LuaClosure, LuaUserdata, NativeFunction,
  callValue, tostringMM, typeName, truthy, getMetatable,
  luaToNumber, numberToString, shortSrc,
} from '../runtime.js';
import { registrar, checkTable } from './helpers.js';
import { Scope, DUMP_MAGIC } from '../interp.js';

export default function install(I) {
  const G = I.globals;
  const native = registrar(G);

  native('print', function* (I, args) {
    const parts = [];
    for (const v of args) {
      const s = yield* tostringMM(v);
      if (typeof s !== 'string') {
        throw new LuaError("'tostring' must return a string to 'print'");
      }
      parts.push(s);
    }
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
    if (args.length === 0) throw new LuaError(`bad argument #1 to 'tonumber' (value expected)`);
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

  const nextFn = native('next', function* (I, args) {
    const t = checkTable(args[0], 1, 'next');
    const pair = t.next(args[1]);
    return pair === null ? [undefined] : pair;
  });

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
    // A string message gains "chunk:line:" from the function `level` frames up
    // (level 1 = the caller of error). Numbers are coerced to strings too.
    if (typeof msg === 'number') msg = numberToString(msg);
    if (typeof msg === 'string' && level > 0) {
      const idx = I.frames.length - level;
      if (idx >= 0 && idx < I.frames.length) {
        const fr = I.frames[idx];
        msg = `${shortSrc(fr.closure.chunkname)}:${fr.line}: ${msg}`;
      }
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

  native('unpack', function* (I, args) {
    const t = checkTable(args[0], 1, 'unpack');
    const i = args[1] === undefined ? 1 : luaToNumber(args[1]);
    const j = args[2] === undefined ? t.len() : luaToNumber(args[2]);
    const out = [];
    for (let k = i; k <= j; k++) out.push(t.get(k));
    return out;
  });

  // No real GC control (V8 manages memory); validate the option like Lua and
  // return plausible values. 'count' reports ~0 KB; set* return the prior value.
  const GC_OPTS = ['stop', 'restart', 'collect', 'count', 'step', 'setpause', 'setstepmul'];
  native('collectgarbage', function* (I, args) {
    const opt = args[0] === undefined ? 'collect' : args[0];
    if (typeof opt !== 'string') {
      throw new LuaError(`bad argument #1 to 'collectgarbage' (string expected, got ${typeName(opt)})`);
    }
    if (!GC_OPTS.includes(opt)) {
      throw new LuaError(`bad argument #1 to 'collectgarbage' (invalid option '${opt}')`);
    }
    if (opt === 'count') return [0, 0];
    if (opt === 'step') return [false];
    return [0];
  });

  native('gcinfo', function* (I, args) {
    return [0]; // KB of memory in use (V8-managed; reported as 0)
  });

  // newproxy([boolean | proxy]): create userdata. true -> fresh metatable;
  // a proxy -> share its metatable; false/absent -> no metatable. (GC
  // finalizers via __gc are accepted but never actually invoked.)
  native('newproxy', function* (I, args) {
    const a = args[0];
    const u = new LuaUserdata(undefined);
    if (a === true) {
      u.metatable = new LuaTable();
    } else if (a instanceof LuaUserdata) {
      u.metatable = a.metatable;
    } else if (a !== undefined && a !== false) {
      throw new LuaError('bad argument #1 to \'newproxy\' (boolean or proxy expected)');
    }
    return [u];
  });

  // Rebuild a closure from string.dump output: AST prototype + upvalue names
  // (whose cells start out nil, as in Lua 5.1).
  function loadDump(s) {
    const data = JSON.parse(s.slice(DUMP_MAGIC.length));
    const scope = new Scope(null);
    for (const name of data.upNames) scope.vars.set(name, { v: undefined });
    const closure = new LuaClosure(data.proto, scope, data.proto.name || null, I);
    closure.chunkname = data.chunkname;
    closure.env = I.genv;
    return closure;
  }

  function compileChunk(source, chunkname) {
    try {
      if (typeof source === 'string' && source.startsWith(DUMP_MAGIC)) return [loadDump(source)];
      return [I.compile(source, chunkname)];
    } catch (e) {
      if (e instanceof LuaError) return [undefined, e.luaMessage];
      throw e;
    }
  }

  const loadFn = native('load', function* (I, args) {
    let [chunk, chunkname] = args;
    if (typeof chunk === 'string') {
      return compileChunk(chunk, typeof chunkname === 'string' ? chunkname : chunk);
    }
    if (typeName(chunk) === 'function') {
      const parts = [];
      try {
        for (;;) {
          const piece = (yield* callValue(chunk, []))[0];
          if (piece === undefined || piece === '') break;
          if (typeof piece !== 'string') return [undefined, 'reader function must return a string'];
          parts.push(piece);
        }
      } catch (e) {
        // An error in the reader function is reported like a load failure.
        if (e instanceof LuaError) {
          return [undefined, typeof e.luaMessage === 'string' ? e.luaMessage : 'error in reader'];
        }
        throw e;
      }
      return compileChunk(parts.join(''), typeof chunkname === 'string' ? chunkname : '=(load)');
    }
    throw new LuaError(`bad argument #1 to 'load' (function expected, got ${typeName(chunk)})`);
  });
  G.set('loadstring', loadFn);

  native('loadfile', function* (I, args) {
    const path = args[0];
    let source;
    try {
      source = fs.readFileSync(path, 'latin1');
    } catch (e) {
      return [undefined, `cannot open ${path}`];
    }
    return compileChunk(source.replace(/^#[^\n]*/, ''), '@' + path);
  });

  native('dofile', function* (I, args) {
    const path = args[0];
    let source;
    try {
      source = fs.readFileSync(path, 'latin1');
    } catch (e) {
      throw new LuaError(`cannot open ${path}`);
    }
    const closure = I.compile(source.replace(/^#[^\n]*/, ''), '@' + path);
    return yield* callValue(closure, []);
  });

  // getfenv/setfenv — function environments. Levels count Lua activations only
  // (native frames like getfenv itself are not on I.frames), so level 1 is the
  // function that called getfenv/setfenv = the top frame.
  function closureAtLevel(level, fname) {
    const idx = I.frames.length - level;
    if (idx < 0 || idx >= I.frames.length) {
      throw new LuaError(`bad argument #1 to '${fname}' (invalid level)`);
    }
    return I.frames[idx].closure;
  }

  native('getfenv', function* (I, args) {
    let f = args[0];
    if (f === undefined) f = 1;
    if (typeof f === 'number') {
      if (f === 0) return [I.genv];
      const c = closureAtLevel(f, 'getfenv');
      return [c.env ?? I.genv];
    }
    if (f instanceof LuaClosure) return [f.env ?? I.genv];
    if (f instanceof NativeFunction) return [I.genv];
    throw new LuaError(`bad argument #1 to 'getfenv' (number expected, got ${typeName(f)})`);
  });

  native('setfenv', function* (I, args) {
    const f = args[0];
    const t = args[1];
    if (!(t instanceof LuaTable)) {
      throw new LuaError(`bad argument #2 to 'setfenv' (table expected, got ${typeName(t)})`);
    }
    if (typeof f === 'number') {
      if (f === 0) { I.genv = t; return []; } // change the thread global environment
      const c = closureAtLevel(f, 'setfenv');
      c.env = t;
      return [c];
    }
    if (f instanceof LuaClosure) { f.env = t; return [f]; }
    throw new LuaError("'setfenv' cannot change environment of given object");
  });

  G.set('_VERSION', 'Lua 5.1');
}
