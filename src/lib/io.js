// io.js — minimal io library: write + read on stdin/stdout (no file handles).
import fs from 'node:fs';
import { LuaError, LuaTable, NativeFunction, numberToString, typeName } from '../runtime.js';

let stdinBuf = null;
let stdinPos = 0;

function slurpStdin() {
  if (stdinBuf !== null) return;
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      break; // EOF-ish conditions
    }
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  stdinBuf = Buffer.concat(chunks).toString('utf8');
}

function readLine() {
  slurpStdin();
  if (stdinPos >= stdinBuf.length) return undefined;
  const nl = stdinBuf.indexOf('\n', stdinPos);
  if (nl < 0) {
    const s = stdinBuf.slice(stdinPos);
    stdinPos = stdinBuf.length;
    return s;
  }
  const s = stdinBuf.slice(stdinPos, nl);
  stdinPos = nl + 1;
  return s;
}

export default function install(I) {
  const lib = new LuaTable();
  const native = (name, fn) => lib.set(name, new NativeFunction(name, fn));

  native('write', function* (I, args) {
    for (let k = 0; k < args.length; k++) {
      const v = args[k];
      if (typeof v === 'string') I.stdout(v);
      else if (typeof v === 'number') I.stdout(numberToString(v));
      else throw new LuaError(`bad argument #${k + 1} to 'write' (string expected, got ${typeName(v)})`);
    }
    return [];
  });

  native('read', function* (I, args) {
    const fmt = args[0] === undefined ? 'l' : args[0];
    const f = typeof fmt === 'string' ? fmt.replace(/^\*/, '') : fmt;
    if (f === 'l' || f === 'L') {
      const line = readLine();
      if (line === undefined) return [undefined];
      return [f === 'L' ? line + '\n' : line];
    }
    if (f === 'a') {
      slurpStdin();
      const s = stdinBuf.slice(stdinPos);
      stdinPos = stdinBuf.length;
      return [s];
    }
    if (f === 'n' || typeof f === 'number') {
      slurpStdin();
      const m = /^[ \t\r\n]*([+-]?(?:0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?))/
        .exec(stdinBuf.slice(stdinPos));
      if (!m) return [undefined];
      stdinPos += m[0].length;
      return [Number(m[1])];
    }
    throw new LuaError(`bad argument #1 to 'read' (invalid format)`);
  });

  I.globals.set('io', lib);
}
