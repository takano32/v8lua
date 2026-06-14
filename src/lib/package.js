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
    const tried = [];
    for (const tmpl of String(pkg.get('path')).split(';')) {
      if (tmpl === '') continue;
      const fn = tmpl.replace(/\?/g, rel);
      if (fs.existsSync(fn)) return { fn };
      tried.push(`\tno file '${fn}'`);
    }
    // C loaders aren't supported, but the error must still list cpath templates
    // (the reference 'require' reports every path it tried).
    for (const tmpl of String(pkg.get('cpath')).split(';')) {
      if (tmpl === '') continue;
      tried.push(`\tno file '${tmpl.replace(/\?/g, rel)}'`);
    }
    return { err: tried.join('\n') };
  }

  registrar(G)('require', function* (I, args) {
    const name = args[0];
    if (typeof name !== 'string') {
      throw new LuaError(`bad argument #1 to 'require' (string expected, got ${typeName(name)})`);
    }
    // Lua tests truthiness: a module that returned false (or nil) is reloaded.
    const already = loaded.get(name);
    if (already !== undefined && already !== false) return [already];

    let loader = preload.get(name);
    if (loader === undefined) {
      const found = searchFile(name);
      if (found.fn === undefined) {
        throw new LuaError(`module '${name}' not found:\n${found.err}`);
      }
      const source = fs.readFileSync(found.fn, 'latin1').replace(/^#![^\n]*/, '');
      loader = I.compile(source, '@' + found.fn);
    }
    // Mark as loaded-in-progress sentinel value true to mirror Lua semantics.
    loaded.set(name, true);
    // Lua 5.1 passes only the module name to the loader.
    const res = (yield* callValue(loader, [name]))[0];
    if (res !== undefined) loaded.set(name, res);
    return [loaded.get(name)];
  });

  // module(name [, ...]): create/locate a module table, set as the caller's env.
  registrar(G)('module', function* (I, args) {
    const name = args[0];
    if (typeof name !== 'string') {
      throw new LuaError(`bad argument #1 to 'module' (string expected, got ${typeName(name)})`);
    }
    // Find or create the module table at its dotted position in the globals,
    // creating intermediate tables and REUSING any table already there (so a
    // table that was an intermediate keeps its existing fields).
    const parts = name.split('.');
    let tbl = G;
    for (let k = 0; k < parts.length - 1; k++) {
      let next = tbl.get(parts[k]);
      if (next === undefined) { next = new LuaTable(); tbl.set(parts[k], next); }
      else if (!(next instanceof LuaTable)) throw new LuaError(`name conflict for module '${name}'`);
      tbl = next;
    }
    const last = parts[parts.length - 1];
    let mod = tbl.get(last);
    if (mod === undefined) {
      mod = loaded.get(name) instanceof LuaTable ? loaded.get(name) : new LuaTable();
      tbl.set(last, mod);
    } else if (!(mod instanceof LuaTable)) {
      throw new LuaError(`name conflict for module '${name}'`);
    }
    if (mod.get('_NAME') === undefined) { // initialize a fresh module table
      mod.set('_NAME', name);
      mod.set('_M', mod);
      const dot = name.lastIndexOf('.');
      mod.set('_PACKAGE', dot >= 0 ? name.slice(0, dot + 1) : ''); // up to last '.'
    }
    loaded.set(name, mod);
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
