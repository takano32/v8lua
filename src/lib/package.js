// package.js — module system: package table, require, and module().
// File loaders only (no C libraries); the search mirrors Lua's package.path.
import fs from 'node:fs';
import {
  LuaError, LuaTable, NativeFunction, callValue, typeName,
} from '../runtime.js';
import { registrar } from './helpers.js';

export default function install(I) {
  const G = I.globals;
  const pkg = new LuaTable();
  const loaded = new LuaTable();
  const preload = new LuaTable();
  pkg.set('loaded', loaded);
  pkg.set('preload', preload);
  pkg.set('path', process.env.LUA_PATH || './?.lua;./?/init.lua');
  pkg.set('cpath', process.env.LUA_CPATH || './?.so');
  pkg.set('loadlib', new NativeFunction('loadlib', function* () {
    return [undefined, 'dynamic libraries not supported', 'absent'];
  }));

  // Pre-register the standard libraries so require returns them directly.
  for (const name of ['string', 'table', 'math', 'io', 'os', 'debug', 'coroutine']) {
    const v = G.get(name);
    if (v !== undefined) loaded.set(name, v);
  }
  loaded.set('_G', G);
  loaded.set('package', pkg);
  G.set('package', pkg);

  function searchFile(name) {
    const rel = name.replace(/\./g, '/');
    const path = String(pkg.get('path'));
    const tried = [];
    for (const tmpl of path.split(';')) {
      if (tmpl === '') continue;
      const fn = tmpl.replace(/\?/g, rel);
      if (fs.existsSync(fn)) return { fn };
      tried.push(`\tno file '${fn}'`);
    }
    return { err: tried.join('\n') };
  }

  registrar(G)('require', function* (I, args) {
    const name = args[0];
    if (typeof name !== 'string') {
      throw new LuaError(`bad argument #1 to 'require' (string expected, got ${typeName(name)})`);
    }
    const already = loaded.get(name);
    if (already !== undefined) return [already];

    let loader = preload.get(name);
    let arg = name;
    if (loader === undefined) {
      const found = searchFile(name);
      if (found.fn === undefined) {
        throw new LuaError(`module '${name}' not found:\n${found.err}`);
      }
      const source = fs.readFileSync(found.fn, 'latin1').replace(/^#![^\n]*/, '');
      loader = I.compile(source, '@' + found.fn);
      arg = found.fn;
    }
    // Mark as loaded-in-progress sentinel value true to mirror Lua semantics.
    loaded.set(name, true);
    const res = (yield* callValue(loader, [name, arg]))[0];
    if (res !== undefined) loaded.set(name, res);
    return [loaded.get(name)];
  });

  // module(name [, ...]): create/locate a module table, set as the caller's env.
  registrar(G)('module', function* (I, args) {
    const name = args[0];
    if (typeof name !== 'string') {
      throw new LuaError(`bad argument #1 to 'module' (string expected, got ${typeName(name)})`);
    }
    let mod = loaded.get(name);
    if (!(mod instanceof LuaTable)) {
      mod = new LuaTable();
      mod.set('_NAME', name);
      mod.set('_M', mod);
      mod.set('_PACKAGE', name.replace(/\.[^.]*$/, ''));
      loaded.set(name, mod);
    }
    // Set the calling function's environment to the module table.
    const caller = I.frames[I.frames.length - 1];
    if (caller !== undefined) caller.closure.env = mod;
    // Apply option functions (e.g. package.seeall) to the module.
    for (let k = 1; k < args.length; k++) {
      yield* callValue(args[k], [mod]);
    }
    return [mod];
  });

  pkg.set('seeall', new NativeFunction('seeall', function* (I, args) {
    const mod = args[0];
    if (!(mod instanceof LuaTable)) {
      throw new LuaError(`bad argument #1 to 'seeall' (table expected, got ${typeName(mod)})`);
    }
    let mt = mod.metatable;
    if (mt === undefined) { mt = new LuaTable(); mod.metatable = mt; }
    mt.set('__index', G);
    return [];
  }));
}
