// table.js — Lua table library.
import {
  LuaError, LuaTable,
  callValue, compare, truthy, typeName, luaToNumber,
} from '../runtime.js';
import { registrar, checkTable } from './helpers.js';

export default function install(I) {
  const lib = new LuaTable();
  const native = registrar(lib);

  native('insert', function* (I, args) {
    const t = checkTable(args[0], 1, 'insert');
    const n = t.len();
    if (args.length === 2) {
      t.set(n + 1, args[1]);
    } else if (args.length === 3) {
      const pos = Math.trunc(luaToNumber(args[1]));
      for (let k = n; k >= pos; k--) t.set(k + 1, t.get(k));
      t.set(pos, args[2]);
    } else {
      throw new LuaError("wrong number of arguments to 'insert'");
    }
    return [];
  });

  native('remove', function* (I, args) {
    const t = checkTable(args[0], 1, 'remove');
    const n = t.len();
    const pos = args[1] === undefined ? n : Math.trunc(luaToNumber(args[1]));
    if (n === 0 && args[1] === undefined) return [undefined];
    const v = t.get(pos);
    for (let k = pos; k < n; k++) t.set(k, t.get(k + 1));
    if (pos <= n) t.set(n, undefined);
    return [v];
  });

  native('concat', function* (I, args) {
    const t = checkTable(args[0], 1, 'concat');
    const sep = args[1] === undefined ? '' : args[1];
    const sepStr = typeof sep === 'number' ? String(sep) : sep;
    if (typeof sepStr !== 'string') {
      throw new LuaError(`bad argument #2 to 'concat' (string expected, got ${typeName(sep)})`);
    }
    const i = args[2] === undefined ? 1 : Math.trunc(luaToNumber(args[2]));
    const j = args[3] === undefined ? t.len() : Math.trunc(luaToNumber(args[3]));
    const out = [];
    for (let k = i; k <= j; k++) {
      const v = t.get(k);
      if (typeof v === 'string') out.push(v);
      else if (typeof v === 'number') out.push(String(v));
      else throw new LuaError(`invalid value (at index ${k}) in table for 'concat'`);
    }
    return [out.join(sepStr)];
  });

  native('sort', function* (I, args) {
    const t = checkTable(args[0], 1, 'sort');
    const comp = args[1];
    function* less(a, b) {
      if (comp !== undefined) return truthy((yield* callValue(comp, [a, b]))[0]);
      return yield* compare('lt', a, b);
    }
    function* msort(a) {
      if (a.length <= 1) return a;
      const mid = a.length >> 1;
      const l = yield* msort(a.slice(0, mid));
      const r = yield* msort(a.slice(mid));
      const out = [];
      let li = 0;
      let ri = 0;
      while (li < l.length && ri < r.length) {
        if (yield* less(r[ri], l[li])) out.push(r[ri++]);
        else out.push(l[li++]);
      }
      while (li < l.length) out.push(l[li++]);
      while (ri < r.length) out.push(r[ri++]);
      return out;
    }
    const n = t.len();
    let arr = [];
    for (let k = 1; k <= n; k++) arr.push(t.get(k));
    arr = yield* msort(arr);
    for (let k = 0; k < n; k++) t.set(k + 1, arr[k]);
    return [];
  });

  native('maxn', function* (I, args) {
    const t = checkTable(args[0], 1, 'maxn');
    let max = 0;
    for (const k of t.hash.keys()) {
      if (typeof k === 'number' && k > max) max = k;
    }
    return [max];
  });

  native('unpack', function* (I, args) {
    const t = checkTable(args[0], 1, 'unpack');
    const i = args[1] === undefined ? 1 : Math.trunc(luaToNumber(args[1]));
    const j = args[2] === undefined ? t.len() : Math.trunc(luaToNumber(args[2]));
    const out = [];
    for (let k = i; k <= j; k++) out.push(t.get(k));
    return out;
  });

  // --- Lua 5.0 compatibility functions (still present in 5.1) ---

  native('getn', function* (I, args) {
    return [checkTable(args[0], 1, 'getn').len()];
  });

  native('setn', function* (I, args) {
    checkTable(args[0], 1, 'setn');
    throw new LuaError("'setn' is obsolete");
  });

  native('foreach', function* (I, args) {
    const t = checkTable(args[0], 1, 'foreach');
    const f = args[1];
    let pair = t.next(undefined);
    while (pair !== null) {
      const r = (yield* callValue(f, [pair[0], pair[1]]))[0];
      if (r !== undefined) return [r];
      pair = t.next(pair[0]);
    }
    return [];
  });

  native('foreachi', function* (I, args) {
    const t = checkTable(args[0], 1, 'foreachi');
    const f = args[1];
    const n = t.len();
    for (let k = 1; k <= n; k++) {
      const r = (yield* callValue(f, [k, t.get(k)]))[0];
      if (r !== undefined) return [r];
    }
    return [];
  });

  I.globals.set('table', lib);
}
