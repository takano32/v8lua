// coroutine.js — coroutine library on top of the generator-based call protocol.
import {
  LuaCoroutine, LuaError, LuaTable, NativeFunction, YIELD,
  callValue, typeName,
} from '../runtime.js';
import { registrar } from './helpers.js';

function* resumeCo(I, c, args) {
  if (!(c instanceof LuaCoroutine)) {
    throw new LuaError(`bad argument #1 to 'resume' (coroutine expected)`);
  }
  if (c.status === 'dead') return [false, 'cannot resume dead coroutine'];
  if (c.status !== 'suspended') return [false, 'cannot resume non-suspended coroutine'];
  const prev = I.coStack[I.coStack.length - 1];
  if (prev !== undefined) prev.status = 'normal';
  I.coStack.push(c);
  c.status = 'running';
  let r;
  try {
    if (!c.started) {
      c.started = true;
      c.it = callValue(c.fn, args);
      r = c.it.next();
    } else {
      r = c.it.next(args);
    }
  } catch (e) {
    c.status = 'dead';
    I.coStack.pop();
    if (prev !== undefined) prev.status = 'running';
    if (e instanceof LuaError) return [false, e.luaMessage];
    if (e instanceof RangeError) return [false, 'stack overflow'];
    throw e;
  }
  I.coStack.pop();
  if (prev !== undefined) prev.status = 'running';
  if (r.done) {
    c.status = 'dead';
    return [true, ...r.value];
  }
  c.status = 'suspended';
  if (r.value && r.value[YIELD]) return [true, ...r.value.values];
  return [true];
}

export default function install(I) {
  const co = new LuaTable();
  const native = registrar(co);

  native('create', function* (I, args) {
    const f = args[0];
    if (typeName(f) !== 'function') {
      throw new LuaError(`bad argument #1 to 'create' (function expected)`);
    }
    return [new LuaCoroutine(f)];
  });

  native('resume', function* (I, args) {
    return yield* resumeCo(I, args[0], args.slice(1));
  });

  native('yield', function* (I, args) {
    if (I.coStack.length === 0) {
      throw new LuaError('attempt to yield from outside a coroutine');
    }
    const back = yield { [YIELD]: true, values: args };
    return back === undefined ? [] : back;
  });

  native('status', function* (I, args) {
    const c = args[0];
    if (!(c instanceof LuaCoroutine)) {
      throw new LuaError(`bad argument #1 to 'status' (coroutine expected)`);
    }
    return [c.status];
  });

  native('running', function* (I, args) {
    return [I.coStack[I.coStack.length - 1]];
  });

  native('wrap', function* (I, args) {
    const f = args[0];
    if (typeName(f) !== 'function') {
      throw new LuaError(`bad argument #1 to 'wrap' (function expected)`);
    }
    const c = new LuaCoroutine(f);
    return [new NativeFunction('wrapped', function* (I, callArgs) {
      const r = yield* resumeCo(I, c, callArgs);
      if (r[0] === true) return r.slice(1);
      const e = new LuaError(r[1]);
      e.positioned = true; // message already carries its own position
      throw e;
    })];
  });

  I.globals.set('coroutine', co);
}
