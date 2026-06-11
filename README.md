# v8lua

A Lua 5.1 interpreter (plus `goto`/labels from 5.2) written in plain modern
JavaScript, running on the V8 engine via Node.js. No dependencies.

Behavior is verified **differentially against LuaJIT**: every conformance test
runs under both `luajit` and v8lua and the outputs must match byte-for-byte —
including number formatting (`%.14g`), error messages with variable-name hints
(`attempt to index local 'x' (a nil value)`), and coroutine semantics.

## Usage

```sh
# run a script
node bin/v8lua.js script.lua [args...]

# one-liner
node bin/v8lua.js -e 'print("hello from lua on v8")'

# REPL
node bin/v8lua.js

# piped stdin
echo 'print(2^10)' | node bin/v8lua.js
```

Embedding from JavaScript:

```js
import { createInterp, runSource } from './src/index.js';

runSource('return 1 + 1');                  // -> [2]

const I = createInterp({ stdout: s => process.stdout.write(s) });
I.run('print("hi")');                        // globals persist across runs
I.run('x = 42');
I.run('print(x)');                           // -> 42
```

## Tests

```sh
npm test                      # diff every tests/lua/*.lua against luajit
node tests/run.js --only 08   # filter by substring
node tests/run.js --update    # snapshot oracle output into tests/expected/
```

17 conformance programs cover literals, arithmetic/coercion, control flow,
closures/varargs/multiple returns, proper tail calls (10^6 deep), tables and
the table library, metatables (all metamethods), the string library, the full
Lua pattern engine, `string.format`, coroutines (incl. nested), errors/pcall/
xpcall, goto/labels, scoping rules, load/loadstring, and a small stress
program.

## Architecture

| File | Role |
|------|------|
| `src/lexer.js` | tokenizer (all literal forms, long brackets, escapes) |
| `src/parser.js` | recursive-descent + precedence-climbing parser → AST |
| `src/runtime.js` | value model, `LuaTable`, metamethod-aware operations |
| `src/interp.js` | generator-based tree-walking evaluator, call protocol |
| `src/lib/lpattern.js` | Lua pattern matcher (port of lstrlib.c logic) |
| `src/lib/*.js` | base / string / table / math / os / io / coroutine libs |
| `src/stdlib.js`, `src/index.js` | assembly + embed API |
| `bin/v8lua.js` | CLI and REPL |
| `docs/SPEC.md` | the binding contract the modules were built against |
| `docs/TASKS.md` | the fine-grained task breakdown used to build this |

### How coroutines work

Every evaluation function is a JS generator, chained with `yield*`. A
`coroutine.yield` deep inside a call stack yields a sentinel object that
propagates transparently through every frame to the driving
`coroutine.resume` loop, which passes resume values back in through
`iterator.next()`. The main chunk's driver rejects stray yields
("attempt to yield from outside a coroutine"). V8's generator machinery
effectively provides the stack switching.

### Proper tail calls

`return f(...)` compiles to a `tailcall` completion: the closure-call loop
rebinds its frame variables instead of recursing, so tail-recursive loops run
in O(1) JS stack.

## Semantics notes / limitations

- Numbers are IEEE doubles (Lua 5.1 model; no 5.3 integer subtype).
  Formatting follows `%.14g`.
- Strings are JS strings (UTF-16 code units); for ASCII data this matches
  Lua's byte semantics. Embedded `\0` works.
- `#` on tables follows border semantics (binary-search like PUC-Lua);
  tables with holes may report a different (but valid) border than LuaJIT's
  array-part heuristic.
- `goto` label visibility is checked per-function (slightly looser than
  Lua 5.2's block scoping).
- Not implemented: file handles in `io` (only `write`/`read` on
  stdout/stdin), `require`/`package`, `string.dump`, `debug` library,
  `os.setlocale`/`tmpname`/`remove`/`rename`, weak tables / `__gc`
  (GC is V8's), `__len` on tables (matches LuaJIT default).
- `error(msg, 2)` uses the current line rather than the caller's line
  (no per-frame line tracking).
