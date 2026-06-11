// Differential test runner: compares v8lua output against luajit (the oracle)
// for every tests/lua/*.lua. See docs/SPEC.md "Determinism & test protocol".
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Interp } from '../src/interp.js';
import installStdlib from '../src/stdlib.js';
import { LuaError, luaToDisplayString } from '../src/runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const luaDir = path.join(here, 'lua');
const expectedDir = path.join(here, 'expected');

const args = process.argv.slice(2);
let only = null;
let update = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only') only = args[++i];
  else if (args[i] === '--update') update = true;
}

let haveLuajit = true;
try {
  execFileSync('luajit', ['-v'], { stdio: 'ignore' });
} catch {
  haveLuajit = false;
}

function oracleOutput(file, name) {
  if (haveLuajit) {
    return execFileSync('luajit', [file], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  }
  const exp = path.join(expectedDir, name.replace(/\.lua$/, '.txt'));
  if (fs.existsSync(exp)) return fs.readFileSync(exp, 'utf8');
  return null;
}

function v8luaOutput(file, name) {
  const out = [];
  // chunkname must match what luajit sees (the path we pass it) so that
  // error-position strings compare equal
  const I = new Interp({ stdout: (s) => out.push(s), chunkname: file });
  installStdlib(I);
  const source = fs.readFileSync(file, 'utf8');
  try {
    I.run(source, file, []);
  } catch (e) {
    if (e instanceof LuaError) {
      const m = e.luaMessage;
      out.push('\nv8lua: uncaught error: ' + (typeof m === 'string' ? m : luaToDisplayString(m)) + '\n');
    } else {
      out.push('\nv8lua: JS exception: ' + (e && e.stack ? e.stack : e) + '\n');
    }
  }
  return out.join('');
}

function firstDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `  line ${i + 1}:\n    oracle: ${JSON.stringify(la[i])}\n    v8lua : ${JSON.stringify(lb[i])}`;
    }
  }
  return '  (outputs differ in whitespace only)';
}

const files = fs.readdirSync(luaDir).filter((f) => f.endsWith('.lua')).sort();
let passed = 0;
let failed = 0;
let skipped = 0;

for (const name of files) {
  if (only !== null && !name.includes(only)) continue;
  const file = path.join(luaDir, name);
  const want = oracleOutput(file, name);
  if (want === null) {
    console.log(`SKIP ${name} (no oracle, no expected file)`);
    skipped++;
    continue;
  }
  if (update && haveLuajit) {
    fs.mkdirSync(expectedDir, { recursive: true });
    fs.writeFileSync(path.join(expectedDir, name.replace(/\.lua$/, '.txt')), want);
  }
  process.env.TZ = 'UTC';
  const got = v8luaOutput(file, name);
  if (got === want) {
    console.log(`\x1b[32mPASS\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`\x1b[31mFAIL\x1b[0m ${name}`);
    console.log(firstDiff(want, got));
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
