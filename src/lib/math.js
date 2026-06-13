// math.js — Lua math library.
import { LuaError, LuaTable } from '../runtime.js';
import { registrar, checkNum } from './helpers.js';

// mulberry32 — deterministic seedable PRNG.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function install(I) {
  const lib = new LuaTable();
  const native = registrar(lib);
  const unary = (name, f) => native(name, function* (I, args) {
    return [f(checkNum(args[0], 1, name))];
  });

  unary('abs', Math.abs);
  unary('ceil', Math.ceil);
  unary('floor', Math.floor);
  unary('sqrt', Math.sqrt);
  unary('sin', Math.sin);
  unary('cos', Math.cos);
  unary('tan', Math.tan);
  unary('asin', Math.asin);
  unary('acos', Math.acos);
  unary('exp', Math.exp);
  unary('deg', (x) => x * 180 / Math.PI);
  unary('rad', (x) => x * Math.PI / 180);

  native('atan', function* (I, args) {
    const y = checkNum(args[0], 1, 'atan');
    if (args[1] === undefined) return [Math.atan(y)];
    return [Math.atan2(y, checkNum(args[1], 2, 'atan'))];
  });

  native('log', function* (I, args) {
    const x = checkNum(args[0], 1, 'log');
    if (args[1] === undefined) return [Math.log(x)];
    return [Math.log(x) / Math.log(checkNum(args[1], 2, 'log'))];
  });

  native('pow', function* (I, args) {
    return [Math.pow(checkNum(args[0], 1, 'pow'), checkNum(args[1], 2, 'pow'))];
  });

  native('fmod', function* (I, args) {
    return [checkNum(args[0], 1, 'fmod') % checkNum(args[1], 2, 'fmod')];
  });

  native('modf', function* (I, args) {
    const x = checkNum(args[0], 1, 'modf');
    const ip = Math.trunc(x);
    return [ip, x - ip];
  });

  native('max', function* (I, args) {
    let m = checkNum(args[0], 1, 'max');
    for (let k = 1; k < args.length; k++) {
      const v = checkNum(args[k], k + 1, 'max');
      if (v > m) m = v;
    }
    return [m];
  });

  native('min', function* (I, args) {
    let m = checkNum(args[0], 1, 'min');
    for (let k = 1; k < args.length; k++) {
      const v = checkNum(args[k], k + 1, 'min');
      if (v < m) m = v;
    }
    return [m];
  });

  let rng = mulberry32(0x9E3779B9);

  native('random', function* (I, args) {
    const r = rng();
    if (args.length === 0) return [r];
    const m = Math.trunc(checkNum(args[0], 1, 'random'));
    if (args.length === 1) {
      if (m < 1) throw new LuaError(`bad argument #1 to 'random' (interval is empty)`);
      return [Math.floor(r * m) + 1];
    }
    const n = Math.trunc(checkNum(args[1], 2, 'random'));
    if (m > n) throw new LuaError(`bad argument #2 to 'random' (interval is empty)`);
    return [Math.floor(r * (n - m + 1)) + m];
  });

  native('randomseed', function* (I, args) {
    rng = mulberry32(Math.trunc(checkNum(args[0], 1, 'randomseed')));
    return [];
  });

  lib.set('huge', Infinity);
  lib.set('pi', Math.PI);

  I.globals.set('math', lib);
}
