// debug.js — Lua debug library. Introspection over the interpreter's frame
// stack and closures; full source-level info where the AST records it.
import {
  LuaError, LuaTable, LuaClosure, NativeFunction, LuaUserdata, LuaCoroutine,
  getMetatable, setTypeMetatable, typeName, shortSrc,
} from '../runtime.js';
import { registrar } from './helpers.js';
import { closureUpvalues, frameLocals } from '../interp.js';

// Collect the set of statement lines in a function body (for getinfo "L").
function activeLines(proto) {
  const lines = new Set();
  function blk(b) { for (const s of b.stmts) stmt(s); }
  function stmt(s) {
    if (s.line) lines.add(s.line);
    if (s.body) blk(s.body);
    if (s.clauses) for (const c of s.clauses) blk(c.body);
    if (s.elseBody) blk(s.elseBody);
  }
  blk(proto.body);
  // Lua maps the implicit final return to the function's last line.
  if (proto.lastline) lines.add(proto.lastline);
  return lines;
}

export default function install(I) {
  const lib = new LuaTable();
  const native = registrar(lib);

  function infoTable(fn, frame, what) {
    const t = new LuaTable();
    const isClosure = fn instanceof LuaClosure;
    const wantAll = what === undefined;
    const wants = (c) => wantAll || what.includes(c);

    if (wants('S')) {
      if (isClosure) {
        const src = fn.chunkname !== undefined ? fn.chunkname : '=?';
        t.set('source', src);
        t.set('short_src', shortSrc(src));
        t.set('linedefined', fn.proto.line || 0);
        t.set('lastlinedefined', fn.proto.lastline ?? (fn.proto.line || 0));
        t.set('what', (fn.proto.line || 0) === 0 ? 'main' : 'Lua');
      } else {
        t.set('source', '=[C]');
        t.set('short_src', '[C]');
        t.set('linedefined', -1);
        t.set('lastlinedefined', -1);
        t.set('what', 'C');
      }
    }
    if (wants('l')) {
      t.set('currentline', frame ? frame.line : -1);
    }
    if (wants('u')) {
      t.set('nups', isClosure ? closureUpvalues(fn).length : 0);
    }
    if (wants('n')) {
      const name = frame ? frame.callName : (isClosure ? fn.name : undefined);
      t.set('name', name == null ? undefined : name); // closures may carry a JS null name
      t.set('namewhat', frame && frame.callKind ? frame.callKind : '');
    }
    if (wants('f')) {
      t.set('func', fn);
    }
    if (wants('L')) {
      if (isClosure) {
        const al = new LuaTable();
        for (const ln of activeLines(fn.proto)) al.set(ln, true);
        t.set('activelines', al);
      } else {
        t.set('activelines', new LuaTable());
      }
    }
    return t;
  }

  native('getinfo', function* (I, args) {
    // Optional leading thread argument is ignored (single-thread model).
    let a = args;
    if (a[0] instanceof LuaCoroutine) a = a.slice(1);
    const target = a[0];
    const what = typeof a[1] === 'string' ? a[1] : undefined;
    if (typeof target === 'number') {
      // Stack level: 1 = the function calling getinfo (getinfo is native and
      // not on the frame stack), so level N -> frames[len - N].
      const idx = I.frames.length - target;
      if (idx < 0 || idx >= I.frames.length) return [undefined];
      const frame = I.frames[idx];
      return [infoTable(frame.closure, frame, what)];
    }
    if (target instanceof LuaClosure || target instanceof NativeFunction) {
      return [infoTable(target, null, what)];
    }
    throw new LuaError(`bad argument #1 to 'getinfo' (function or level expected)`);
  });

  native('traceback', function* (I, args) {
    let a = args;
    if (a[0] instanceof LuaCoroutine) a = a.slice(1);
    const msg = a[0];
    if (msg !== undefined && typeof msg !== 'string') return [msg]; // non-string: returned as-is
    const level = a[1] === undefined ? 1 : Math.trunc(a[1]);
    const lines = [];
    if (msg !== undefined) lines.push(msg);
    lines.push('stack traceback:');
    if (I._handlerFrames !== undefined) {
      // Inside an xpcall handler: use the snapshot taken when the error was
      // raised (the live stack has already unwound). Snapshot is innermost-first.
      const snap = I._handlerFrames;
      for (let i = level - 1; i < snap.length; i++) {
        const fr = snap[i];
        let where;
        if (fr.name) where = `in function '${fr.name}'`;
        else if (fr.main) where = 'in main chunk';
        else where = `in function <${fr.src}:?>`;
        lines.push(`\t${fr.src}:${fr.line}: ${where}`);
      }
    } else {
      // Walk live frames from the given level (1 = caller of traceback) outward.
      for (let i = I.frames.length - level; i >= 0; i--) {
        const fr = I.frames[i];
        const c = fr.closure;
        const src = shortSrc(c.chunkname || '=?');
        let where;
        if (fr.callName) where = `in function '${fr.callName}'`;
        else if ((c.proto.line || 0) === 0) where = 'in main chunk';
        else where = `in function <${src}:${c.proto.line || 0}>`;
        lines.push(`\t${src}:${fr.line}: ${where}`);
      }
    }
    lines.push('\t[C]: ?');
    return [lines.join('\n')];
  });

  native('sethook', function* (I, args) {
    const fn = args[0];
    const mask = typeof args[1] === 'string' ? args[1] : '';
    const count = typeof args[2] === 'number' ? args[2] : 0;
    if (fn === undefined || fn === null) {
      I.hook = null;
      return [];
    }
    I.hook = {
      fn,
      mask,
      count,
      line: mask.includes('l'),
      call: mask.includes('c'),
      ret: mask.includes('r'),
    };
    // The frame that installs the hook is already mid-line; baseline its
    // line so the next same-line statement doesn't fire a spurious event.
    const top = I.frames[I.frames.length - 1];
    if (top !== undefined) top.hookLine = top.line;
    return [];
  });

  native('gethook', function* (I, args) {
    if (I.hook === null) return [undefined, '', 0];
    // Mask is reported in canonical order: call, return, line.
    const mask = (I.hook.call ? 'c' : '') + (I.hook.ret ? 'r' : '') + (I.hook.line ? 'l' : '');
    return [I.hook.fn, mask, I.hook.count || 0];
  });

  native('getupvalue', function* (I, args) {
    const f = args[0];
    const n = Math.trunc(args[1]);
    if (!(f instanceof LuaClosure)) return [undefined];
    const ups = closureUpvalues(f);
    if (n < 1 || n > ups.length) return [undefined];
    return [ups[n - 1].name, ups[n - 1].cell.v];
  });

  native('setupvalue', function* (I, args) {
    const f = args[0];
    const n = Math.trunc(args[1]);
    const val = args[2];
    if (!(f instanceof LuaClosure)) return [undefined];
    const ups = closureUpvalues(f);
    if (n < 1 || n > ups.length) return [undefined];
    ups[n - 1].cell.v = val;
    return [ups[n - 1].name];
  });

  native('getmetatable', function* (I, args) {
    const mt = getMetatable(args[0]);
    return [mt === undefined ? undefined : mt];
  });

  native('setmetatable', function* (I, args) {
    const v = args[0];
    const mt = args[1];
    if (mt !== undefined && !(mt instanceof LuaTable)) {
      throw new LuaError('bad argument #2 to \'setmetatable\' (nil or table expected)');
    }
    // debug.setmetatable can set the metatable of any value, including the
    // shared per-basic-type metatable.
    if (v instanceof LuaTable || v instanceof LuaUserdata) v.metatable = mt;
    else setTypeMetatable(typeName(v), mt);
    return [v];
  });

  native('getfenv', function* (I, args) {
    const f = args[0];
    if (f instanceof LuaClosure) return [f.env ?? I.genv];
    return [I.genv];
  });

  native('setfenv', function* (I, args) {
    const f = args[0];
    const t = args[1];
    if (f instanceof LuaClosure && t instanceof LuaTable) { f.env = t; return [f]; }
    throw new LuaError("'setfenv' cannot change environment of given object");
  });

  // Local variables of the function at a stack level, by register (declaration)
  // order. Level 1 = the function calling getlocal (getlocal is native and not
  // on the frame stack), so level N -> frames[len - N].
  native('getlocal', function* (I, args) {
    const level = Math.trunc(args[0]);
    const n = Math.trunc(args[1]);
    // Level 0 = the running C function's own stack slots (its arguments),
    // reported as unnamed temporaries (Lua's "(*temporary)").
    if (level === 0) {
      if (n >= 1 && n <= args.length) return ['(*temporary)', args[n - 1]];
      return [undefined];
    }
    const idx = I.frames.length - level;
    if (idx < 0 || idx >= I.frames.length) {
      throw new LuaError("bad argument #1 to 'getlocal' (level out of range)");
    }
    const locals = frameLocals(I.frames[idx]);
    if (n < 1 || n > locals.length) return [undefined];
    return [locals[n - 1].name, locals[n - 1].cell.v];
  });

  native('setlocal', function* (I, args) {
    const level = Math.trunc(args[0]);
    const n = Math.trunc(args[1]);
    const idx = I.frames.length - level;
    if (idx < 0 || idx >= I.frames.length) {
      throw new LuaError("bad argument #1 to 'setlocal' (level out of range)");
    }
    const locals = frameLocals(I.frames[idx]);
    if (n < 1 || n > locals.length) return [undefined];
    locals[n - 1].cell.v = args[2];
    return [locals[n - 1].name];
  });
  native('getregistry', function* (I, args) { return [new LuaTable()]; });

  I.globals.set('debug', lib);
}
