// helpers.js — shared plumbing for the standard-library modules: a registrar
// for installing natives into a table, and argument-checking helpers that
// mirror PUC-Lua's luaL_check* error messages.
import {
  LuaError, LuaTable, NativeFunction,
  luaToNumber, numberToString, typeName,
} from '../runtime.js';

// Returns a `native(name, fn)` registrar that wraps `fn` in a NativeFunction,
// stores it in `table` under `name`, and returns the NativeFunction (handy when
// a lib needs to reference one of its own functions, e.g. `next` from `pairs`).
export function registrar(table) {
  return (name, fn) => {
    const f = new NativeFunction(name, fn);
    table.set(name, f);
    return f;
  };
}

export function argError(n, fname, detail) {
  return new LuaError(`bad argument #${n} to '${fname}' (${detail})`);
}

// "got no value" for a missing argument vs. the type name for an explicit one,
// matching luaL_typerror.
function gotName(v) {
  return v === undefined ? 'no value' : typeName(v);
}

export function checkTable(v, n, fname) {
  if (v instanceof LuaTable) return v;
  // luaL_checktype reports the actual type ('nil') for an explicit nil here.
  throw argError(n, fname, `table expected, got ${typeName(v)}`);
}

export function checkNum(v, n, fname) {
  const x = luaToNumber(v);
  if (x === undefined) throw argError(n, fname, `number expected, got ${gotName(v)}`);
  return x;
}

export function checkStr(v, n, fname) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberToString(v);
  throw argError(n, fname, `string expected, got ${gotName(v)}`);
}

export function optNum(v, def, n, fname) {
  return v === undefined ? def : checkNum(v, n, fname);
}
