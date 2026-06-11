// Public API for embedding v8lua in JavaScript programs.
import { Interp } from './interp.js';
import installStdlib from './stdlib.js';
import { LuaError, LuaTable, luaToDisplayString } from './runtime.js';

export { Interp, LuaError, LuaTable, installStdlib };

// Create an interpreter with the full standard library installed.
// opts: { stdout?: (s) => void, stderr?: (s) => void, chunkname?: string }
export function createInterp(opts = {}) {
  const I = new Interp(opts);
  installStdlib(I);
  return I;
}

// Run Lua source to completion; returns the chunk's return values (JS array).
export function runSource(source, opts = {}) {
  const I = createInterp(opts);
  return I.run(source, opts.chunkname ?? 'v8lua', opts.args ?? []);
}

// Format a Lua error value for display on stderr.
export function formatError(e) {
  if (e instanceof LuaError) {
    const m = e.luaMessage;
    return typeof m === 'string' ? m : luaToDisplayString(m);
  }
  return String(e && e.stack ? e.stack : e);
}
