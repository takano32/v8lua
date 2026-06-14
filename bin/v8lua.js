#!/usr/bin/env node
// v8lua CLI: run Lua scripts on V8 (Node.js), or start a REPL.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createInterp, formatError } from '../src/index.js';
import { LuaTable, tostringMM, runToCompletion } from '../src/runtime.js';

const VERSION = 'v8lua 0.1.0 — Lua 5.1 on V8 (Node.js ' + process.version + ')';

function usage() {
  process.stderr.write(
    'usage: v8lua [options] [script [args]]\n' +
    '  -e code   execute string code\n' +
    '  -i        enter interactive mode after running script\n' +
    '  -v        show version information\n');
}

function main() {
  const argv = process.argv.slice(2);
  let script = null, scriptArgs = [], evalChunks = [], interactive = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (script === null && a === '-e') {
      if (i + 1 >= argv.length) { usage(); process.exit(1); }
      evalChunks.push(argv[++i]);
    } else if (script === null && a === '-i') {
      interactive = true;
    } else if (script === null && a === '-v') {
      process.stdout.write(VERSION + '\n');
      if (evalChunks.length === 0 && i === argv.length - 1) process.exit(0);
    } else if (script === null && (a === '-h' || a === '--help')) {
      usage(); process.exit(0);
    } else if (script === null) {
      script = a;
      scriptArgs = argv.slice(i + 1);
      break;
    }
  }

  const I = createInterp({});

  // Lua's global `arg` table: arg[0] = script, arg[1..] = args, arg[-1] = interpreter.
  const argTable = new LuaTable();
  argTable.set(-1, process.argv[0]);
  if (script !== null) argTable.set(0, script);
  scriptArgs.forEach((s, i) => argTable.set(i + 1, s));
  I.globals.set('arg', argTable);

  try {
    for (const code of evalChunks) {
      I.run(code, '=(command line)', scriptArgs);
    }
    if (script !== null) {
      const source = fs.readFileSync(script, 'latin1')
        .replace(/^#[^\n]*/, ''); // Lua skips a leading '#' line (shebang/comment)
      I.run(source, '@' + path.basename(script), scriptArgs);
    }
  } catch (e) {
    process.stderr.write('v8lua: ' + formatError(e) + '\n');
    process.exit(1);
  }

  if (interactive || (script === null && evalChunks.length === 0 && process.stdin.isTTY)) {
    repl(I);
  } else if (script === null && evalChunks.length === 0) {
    // piped stdin: run it as a chunk
    const source = fs.readFileSync(0, 'latin1');
    try {
      I.run(source, '=stdin', []);
    } catch (e) {
      process.stderr.write('v8lua: ' + formatError(e) + '\n');
      process.exit(1);
    }
  }
}

function repl(I) {
  process.stdout.write(VERSION + '\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', (line) => {
    line = line.trim();
    if (line.length > 0) {
      try {
        let results = null;
        let ranAsExpr = false;
        try {
          I.compile('return ' + line, '=stdin');
          ranAsExpr = true;
        } catch { /* not an expression; run as statement */ }
        results = I.run(ranAsExpr ? 'return ' + line : line, '=stdin', []);
        if (ranAsExpr && results.length > 0) {
          const parts = results.map(v => runToCompletion(tostringMM(v)));
          process.stdout.write(parts.join('\t') + '\n');
        }
      } catch (e) {
        process.stdout.write(formatError(e) + '\n');
      }
    }
    rl.prompt();
  });
  rl.on('close', () => { process.stdout.write('\n'); process.exit(0); });
}

main();
