// io.js — Lua io library with file handles backed by Node fs (synchronous).
// Files are LuaUserdata whose `data` is a handle record; a shared metatable
// provides the method table (__index), __tostring and __gc.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LuaError, LuaTable, LuaUserdata, NativeFunction,
  numberToString, typeName, luaToNumber,
} from '../runtime.js';
import { registrar } from './helpers.js';

let tmpCounter = 0;

// Read a file descriptor's bytes as a latin1 string so each byte maps to one
// char (Lua strings are byte strings). Reads to EOF.
function slurpFd(fd) {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      break;
    }
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('latin1');
}

export default function install(I) {
  const lib = new LuaTable();
  const native = registrar(lib);

  // Shared metatable + method table for all file handles.
  const methods = new LuaTable();
  const fileMeta = new LuaTable();
  fileMeta.set('__index', methods);

  function isFile(v) { return v instanceof LuaUserdata && v.data && v.data.kind === 'file'; }

  function checkFile(v, fname) {
    if (isFile(v)) {
      if (v.data.closed) throw new LuaError('attempt to use a closed file');
      return v.data;
    }
    const got = v === undefined ? 'no value' : typeName(v);
    throw new LuaError(`bad argument #1 to '${fname}' (FILE* expected, got ${got})`);
  }

  function makeFile(rec) {
    const u = new LuaUserdata(rec);
    u.metatable = fileMeta;
    return u;
  }

  // Real files keep their whole content in memory (latin1) with a position;
  // writes are flushed to disk on flush/close. Std streams bypass this.
  function ensureReadBuf(rec) {
    if (rec.std === 'in' && rec.content === undefined) { rec.content = slurpFd(0); rec.pos = 0; }
  }

  function readNumber(rec) {
    const m = /^[ \t\r\n]*([+-]?(?:0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?))/
      .exec(rec.content.slice(rec.pos));
    if (!m) return undefined;
    rec.pos += m[0].length;
    return Number(m[1]);
  }

  function readLine(rec, keepEol) {
    if (rec.pos >= rec.content.length) return undefined;
    const nl = rec.content.indexOf('\n', rec.pos);
    if (nl < 0) {
      const s = rec.content.slice(rec.pos);
      rec.pos = rec.content.length;
      return s;
    }
    const s = rec.content.slice(rec.pos, keepEol ? nl + 1 : nl);
    rec.pos = nl + 1;
    return s;
  }

  function readOne(rec, fmt) {
    if (typeof fmt === 'number') {
      if (rec.pos >= rec.content.length && fmt > 0) return undefined;
      const s = rec.content.slice(rec.pos, rec.pos + fmt);
      rec.pos += s.length;
      return s;
    }
    const f = typeof fmt === 'string' ? fmt.replace(/^\*/, '') : 'l';
    if (f === 'l') return readLine(rec, false);
    if (f === 'L') return readLine(rec, true);
    if (f === 'a') { const s = rec.content.slice(rec.pos); rec.pos = rec.content.length; return s; }
    if (f === 'n') return readNumber(rec);
    throw new LuaError(`bad argument to 'read' (invalid format)`);
  }

  function* doRead(rec, fmts) {
    ensureReadBuf(rec);
    if (fmts.length === 0) return [readLine(rec, false)];
    const out = [];
    for (const fmt of fmts) out.push(readOne(rec, fmt));
    return out;
  }

  function flush(rec) {
    if (rec.dirty && rec.name !== undefined) {
      fs.writeFileSync(rec.name, Buffer.from(rec.content, 'latin1'));
      rec.dirty = false;
    }
  }

  function writeStr(rec, v, k) {
    let s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number') s = numberToString(v);
    else throw new LuaError(`bad argument #${k} to 'write' (string expected, got ${typeName(v)})`);
    if (rec.std === 'out') { I.stdout(s); return; }
    if (rec.std === 'err') { I.stderr(s); return; }
    if (!rec.canWrite) throw new LuaError('file not opened for writing');
    rec.content = rec.content.slice(0, rec.pos) + s + rec.content.slice(rec.pos + s.length);
    rec.pos += s.length;
    rec.dirty = true;
  }

  // --- file methods ---
  const fmethod = registrar(methods);

  fmethod('read', function* (I, args) {
    const rec = checkFile(args[0], 'read');
    return yield* doRead(rec, args.slice(1));
  });

  fmethod('write', function* (I, args) {
    const self = args[0];
    const rec = checkFile(self, 'write');
    for (let k = 1; k < args.length; k++) writeStr(rec, args[k], k);
    return [self];
  });

  fmethod('lines', function* (I, args) {
    const rec = checkFile(args[0], 'lines');
    ensureReadBuf(rec);
    return [new NativeFunction('lines_iter', function* () { return [readLine(rec, false)]; })];
  });

  const closeFn = fmethod('close', function* (I, args) {
    const rec = checkFile(args[0], 'close');
    flush(rec);
    rec.closed = true;
    return [true];
  });

  fmethod('flush', function* (I, args) {
    flush(checkFile(args[0], 'flush'));
    return [args[0]];
  });

  fmethod('seek', function* (I, args) {
    const rec = checkFile(args[0], 'seek');
    const whence = args[1] === undefined ? 'cur' : args[1];
    const offset = args[2] === undefined ? 0 : Math.trunc(luaToNumber(args[2]));
    const len = rec.content === undefined ? 0 : rec.content.length;
    if (whence === 'set') rec.pos = offset;
    else if (whence === 'cur') rec.pos += offset;
    else if (whence === 'end') rec.pos = len + offset;
    else throw new LuaError(`bad argument #1 to 'seek' (invalid option '${whence}')`);
    return [rec.pos];
  });

  fmethod('setvbuf', function* (I, args) {
    checkFile(args[0], 'setvbuf');
    return [args[0]]; // buffering is a no-op
  });

  const gcFn = new NativeFunction('__gc', function* (I, args) {
    checkFile(args[0], '__gc');
    return [];
  });
  methods.set('__gc', gcFn);
  fileMeta.set('__gc', gcFn);
  fileMeta.set('__tostring', new NativeFunction('__tostring', function* (I, args) {
    const rec = args[0].data;
    return [rec.closed ? 'file (closed)' : 'file (' + (rec.name || 'fd ' + rec.fd) + ')'];
  }));

  // --- standard streams ---
  const stdinFile = makeFile({ kind: 'file', std: 'in' });
  const stdoutFile = makeFile({ kind: 'file', std: 'out' });
  const stderrFile = makeFile({ kind: 'file', std: 'err' });
  lib.set('stdin', stdinFile);
  lib.set('stdout', stdoutFile);
  lib.set('stderr', stderrFile);

  let defaultInput = stdinFile;
  let defaultOutput = stdoutFile;

  // --- library functions ---
  const openFn = native('open', function* (I, args) {
    const name = args[0];
    const mode = args[1] === undefined ? 'r' : String(args[1]);
    if (typeof name !== 'string') {
      throw new LuaError(`bad argument #1 to 'open' (string expected, got ${typeName(name)})`);
    }
    const m = mode.replace('b', '');
    const canWrite = m !== 'r';
    let content = '';
    let pos = 0;
    try {
      if (m === 'r' || m === 'r+') {
        content = fs.readFileSync(name, 'latin1');
      } else if (m === 'a' || m === 'a+') {
        try { content = fs.readFileSync(name, 'latin1'); } catch { content = ''; }
        pos = content.length;
      } else if (m === 'w' || m === 'w+') {
        fs.writeFileSync(name, ''); // create/truncate now
      } else {
        throw new LuaError(`bad argument #2 to 'open' (invalid mode '${mode}')`);
      }
    } catch (e) {
      if (e instanceof LuaError) throw e;
      const why = e.code === 'ENOENT' ? 'No such file or directory' : e.message;
      return [undefined, `${name}: ${why}`, e.errno || -1];
    }
    return [makeFile({ kind: 'file', name, mode: m, canWrite, content, pos })];
  });

  native('close', function* (I, args) {
    const f = args[0] === undefined ? defaultOutput : args[0];
    return yield* closeFn.fn(I, [f]);
  });

  native('write', function* (I, args) {
    const rec = checkFile(defaultOutput, 'write');
    for (let k = 0; k < args.length; k++) writeStr(rec, args[k], k + 1);
    return [defaultOutput];
  });

  native('read', function* (I, args) {
    const rec = checkFile(defaultInput, 'read');
    return yield* doRead(rec, args);
  });

  native('lines', function* (I, args) {
    if (args[0] === undefined) {
      const rec = checkFile(defaultInput, 'lines');
      ensureReadBuf(rec);
      return [new NativeFunction('lines_iter', function* () { return [readLine(rec, false)]; })];
    }
    const opened = yield* openFn.fn(I, [args[0], 'r']);
    if (opened[0] === undefined) throw new LuaError(opened[1]);
    return yield* methods.get('lines').fn(I, [opened[0]]);
  });

  native('input', function* (I, args) {
    if (args[0] === undefined) return [defaultInput];
    if (typeof args[0] === 'string') {
      const opened = yield* openFn.fn(I, [args[0], 'r']);
      if (opened[0] === undefined) throw new LuaError(opened[1]);
      defaultInput = opened[0];
    } else {
      checkFile(args[0], 'input');
      defaultInput = args[0];
    }
    return [defaultInput];
  });

  native('output', function* (I, args) {
    if (args[0] === undefined) return [defaultOutput];
    if (typeof args[0] === 'string') {
      const opened = yield* openFn.fn(I, [args[0], 'w']);
      if (opened[0] === undefined) throw new LuaError(opened[1]);
      defaultOutput = opened[0];
    } else {
      checkFile(args[0], 'output');
      defaultOutput = args[0];
    }
    return [defaultOutput];
  });

  native('type', function* (I, args) {
    const v = args[0];
    if (!isFile(v)) return [undefined];
    return [v.data.closed ? 'closed file' : 'file'];
  });

  native('tmpfile', function* (I, args) {
    const name = path.join(os.tmpdir(), `v8lua_tmp_${process.pid}_${tmpCounter++}`);
    fs.writeFileSync(name, '');
    return [makeFile({ kind: 'file', name, mode: 'w+', canWrite: true, content: '', pos: 0, temp: true })];
  });

  I.globals.set('io', lib);
}
