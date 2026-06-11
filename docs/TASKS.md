# v8lua — Fine-grained Task Breakdown

Each task below is sized so that a mid-capability model (e.g. Opus at medium
effort) can implement it **in isolation**: one file (or one cohesive section of
a file), no global design decisions (those are all fixed in `docs/SPEC.md`),
and a concrete acceptance check. Implementers MUST read `docs/SPEC.md` first —
it is the binding contract; TASKS.md only scopes and orders the work.

## Global rules (apply to every task)

- Plain modern JavaScript, ESM. **No TypeScript syntax. No dependencies.** Node >= 18.
- After editing, run `node --check <file>` until clean.
- The behavior oracle is the `luajit` binary on PATH (Lua 5.1). When unsure of a
  semantic, check it: `luajit -e 'print(...)'`.
- Touch only the files named in your task. Tasks that edit the same file are
  strictly ordered — never run them concurrently.
- Throw only `LuaError` (from `src/runtime.js`) for Lua-level errors; message
  strings must match SPEC.md exactly.
- Acceptance scripts live under `scratch/` (gitignored); keep them, they are
  rerun by later tasks as regression checks. Name: `scratch/accept-TNN.mjs`
  (or `.lua`). A task is done only when its acceptance run prints all-OK.

## Current state

Already present (do not rewrite from scratch):
- `docs/SPEC.md` — the contract (authoritative).
- `package.json` — done.
- `src/lexer.js` — written but **unverified** (T01 verifies/fixes it).
- `src/stdlib.js`, `src/index.js`, `bin/v8lua.js` — integration shims, written
  against SPEC; verified in T27.

Dependency notation: `Depends: T05` means that task must be completed first.

---

## Phase 1 — Lexer

### T01 — Verify and complete the lexer
**File:** `src/lexer.js` (exists; fix in place) · **Depends:** — · **Spec:** "Token format"
- Write `scratch/accept-T01.mjs`: tokenize each snippet below, print compact
  `type:value@line` lists, and assert the expected properties:
  1. `local x = 0xFF + 0x1p4 + .5 + 1e-2` → number values `255, 16, 0.5, 0.01`.
  2. `s = "a\65\x42\n\\" .. [[raw
     line]] .. [==[a]b]==]` → string values `aAB\n\\`, `raw\nline` (leading
     newline after `[[` skipped), `a]b`.
  3. `--[==[ long
     comment ]==] x = 1 -- tail` → only `name(x) op(=) number(1) eof`; `x` is
     on line 3 (line counting inside long comments).
  4. `a ... .. . == ~= <= >= :: :` each lexes as the right single op
     (longest match).
  5. `"unfinished` and `[==[never closed` and `0x` → each throws LuaError whose
     message starts `chunk:1:`.
  6. `\z` skips whitespace incl. newlines; `\300` → error.
- Fix `src/lexer.js` until acceptance passes. Keep exports exactly
  `tokenize(source, chunkname)`.
- Note: lexer imports `LuaError` from `./runtime.js`, which may not exist yet.
  For acceptance only, create a 3-line stub `scratch/runtime-stub.mjs` is NOT
  allowed to replace the import — instead create the real `src/runtime.js`
  early IF T05 hasn't run: a minimal file containing only
  `export class LuaError extends Error { constructor(m){ super(typeof m==='string'?m:'(error object)'); this.luaMessage=m; this.positioned=false; } }`
  (T05 will extend the same file; do not duplicate the class later).

## Phase 2 — Parser (one file, three strictly ordered tasks)

### T02 — Expression parser core
**File:** `src/parser.js` (new) · **Depends:** T01 · **Spec:** "AST specification"
- Implement the token cursor (peek/next/expect with error messages per spec)
  and `parseExpr` by precedence climbing for: literals (nil/true/false/
  number/string/vararg), `NameExpr`, `ParenExpr`, `BinopExpr`/`UnopExpr` with
  the exact precedence/associativity table (`..` and `^` right-assoc; `^`
  tighter than unary: `-2^2` parses as `-(2^2)`; `not`/`#`/`-` unary).
- Temporary export for testing: `parseExpression(tokens, chunkname)` (keep it;
  harmless later). Also export a `parse` that for now accepts only
  `return <expr>` chunks — T04 replaces it.
- Acceptance `scratch/accept-T02.mjs`: JSON.stringify ASTs for:
  `-2^2`, `2^-2`, `1+2*3 == 7 and not false`, `"a".."b".."c"` (right-nested),
  `#"x" + 1`, `(f)` (ParenExpr wrapping NameExpr) — assert shapes/nesting
  (e.g. `-2^2` → UnopExpr{op:'-', expr:BinopExpr{op:'^'}}).

### T03 — Suffixed expressions, calls, functions, tables
**File:** `src/parser.js` · **Depends:** T02 · **Spec:** "AST specification"
- Prefix/suffix machinery: `IndexExpr` (`a.b` → StringExpr key; `a[e]`),
  `CallExpr`, `MethodCallExpr` (`a:b(...)`), call sugar `f"s"`, `f{…}`,
  chained suffixes (`a.b(c)[d]:e{}` ...).
- `FuncExpr`: `function (a, b, ...) body end` — params, isVararg, body via a
  `parseBlock` stub that for now handles only `return exprlist` and statement-
  less blocks (T04 completes it). `TableExpr` with all three field forms +
  separators `,`/`;` + trailing separator.
- Acceptance: AST shape checks for `t={1,2,x=3,[k]=4,f(),}`,
  `obj:m(1)"s"{}`, `function(...) return ... end`, `f{x=1}"y"`.

### T04 — Statements, desugarings, parser checks
**File:** `src/parser.js` · **Depends:** T03 · **Spec:** "AST specification"
- Full `parseBlock`/`parseStatement`: every Stat node from the spec; `;` empty
  statements skipped; `return` only last (optional trailing `;`).
- Desugar: `function a.b.c(…)`/`function a.b:m(…)` (prepend `"self"`),
  `local function f`, with FuncExpr.name set for error messages.
- Checks: `break` only inside loops; `...` only in vararg functions; `goto`
  label must exist in the enclosing function (collect labels per function).
- Acceptance `scratch/accept-T04.mjs`: parse a ~60-line kitchen-sink program
  (every statement form, nested functions, goto/labels, method definitions)
  → asserts on key shapes; plus negative cases: `break` outside loop,
  `...` in non-vararg, `goto nowhere`, `return 1 x=2` each throw with
  `chunk:LINE:` prefixed messages.

## Phase 3 — Runtime (one file, five strictly ordered tasks)

### T05 — Value helpers and error class
**File:** `src/runtime.js` (may exist as LuaError stub from T01 — extend) ·
**Depends:** — · **Spec:** "src/runtime.js — exact exports"
- `LuaError`, `YIELD` symbol, `typeName`, `truthy`, `luaToNumber` (whitespace,
  decimal/exponent, `0x` hex int + hex float, base 2..36), `numberToString`
  (%.14g emulation per spec: 'nan'/'inf'/'-inf'/'-0', integers <1e15 plain,
  toPrecision(14) + strip + `e+NN`), `luaToDisplayString` (ids via counter).
- Acceptance `scratch/accept-T05.mjs`: for each n in
  `[0, -0, 3, 3.5, 0.1, 2^53, 1e15, 1e16, 1/3, 1e100, 1e-5, -1.5e-300, 123456789012345.6, 1/0, -1/0, 0/0]`
  compare `numberToString(n)` with `luajit -e 'io.write(tostring(n))'`
  (generate the luajit side from the same list inside the script via
  execFileSync). For luaToNumber: `' 10 '→10`, `'0x10'→16`, `'0x1p4'→16`,
  `'10e'→undefined`, `'0b'→undefined`, `('ff',16)→255`, `('z',36)→35`,
  `('10',2)→2`, `(' 0x10 ',16)`→undefined? — check oracle
  `luajit -e 'print(tonumber("0x10",16))'` and match it.

### T06 — LuaTable
**File:** `src/runtime.js` · **Depends:** T05 · **Spec:** LuaTable section
- `get`/`set` (−0→0 normalization; nil/NaN key write errors, reads return nil;
  set nil deletes), `len()` (doubling probe + binary search border), `next(k)`
  (snapshot cache; deleted-key skipping; `invalid key to 'next'`).
- Acceptance: border cases `{1,2,3}→3`, `{}`→0, `{[1]=1,[2]=2,[4]=4}` → 2 or 4
  (assert it equals luajit's `#` for the same construction — build via
  sequential sets 1,2 then 4), `t[i]=i for 1..100` → 100 then `t[50]=nil` →
  `len() ∈ {49,100}`; next() full iteration sees exactly the live keys; set
  current key to nil mid-iteration still completes.

### T07 — Function objects and call dispatch
**File:** `src/runtime.js` · **Depends:** T06 · **Spec:** runtime exports
- `NativeFunction`, `LuaClosure`, `LuaCoroutine` classes; `setClosureCall`,
  `setCurrentInterp`/`getCurrentInterp`, `setStringLibrary`; generator
  `callValue` (closure → injected closureCall; native → `fn(I, args)`;
  `__call` chain; else `attempt to call a X value`).
- Acceptance: with a stub closureCall (`function*(c,a){return [c.tag, ...a]}`),
  callValue on closures/natives/tables-with-__call/non-callables; verify a
  native that yields a `{[YIELD]:true}` sentinel passes it through `yield*`.

### T08 — index/newindex and metatable access
**File:** `src/runtime.js` · **Depends:** T07 · **Spec:** runtime exports
- `getMetatable` (string mt via setStringLibrary), generator `index` (raw hit;
  `__index` table chain — loop, not recursion, with a depth guard ~100 then
  `'__index' chain too long; possible loop` — check exact luajit message:
  `luajit -e 't=setmetatable({},{__index=0/0}) print(t.x)'` is not the case;
  use a 2-table cycle to see it), function `__index` via callValue; strings
  index the string library; errors per spec.
- `newindex` symmetrically (`__newindex` table/function; raw set when key
  already present — must use **raw** presence check).
- Acceptance: chains of 3 metatables; function handlers (stub natives);
  string indexing returns from a fake string lib table; error messages exact.

### T09 — Operators: arith/compare/concat/len/tostringMM
**File:** `src/runtime.js` · **Depends:** T08 · **Spec:** runtime exports
- `arith` (numeric-string coercion; Lua `%` floor-mod semantics — verify
  `-5%3`, `5%-3`, `-5.5%3` against luajit; `unm`; metamethod fallback with the
  operand-selection rule), `compare` (`eq` incl. `__eq` only both tables;
  `lt/le` numbers/strings; `__le` → `not __lt(b,a)` fallback; exact mixed-type
  error messages), `concat` (numbers via numberToString; `__concat` a-then-b),
  `len` (`__len` for tables honored… verify luajit 5.1: tables ignore `__len`?
  `luajit -e 'print(#setmetatable({},{__len=function() return 9 end}))'` —
  match the oracle), `tostringMM`.
- Acceptance: ~40 assertions incl. metamethod dispatch order (lhs first),
  `1=="1"` false, `"a"<"b"`, `"10"<"9"` (string compare!), `2<"x"` errors.

## Phase 4 — Interpreter (one file, four ordered tasks) + coroutines

### T10 — Interp scaffold: scopes, expressions, return
**File:** `src/interp.js` (new) · **Depends:** T04, T09 · **Spec:** "src/interp.js" + "Evaluator architecture"
- `Interp` class (constructor/opts/globals/currentLine/chunkname), `compile`
  (lex+parse → LuaClosure with null-parent scope), `run` (drive generator;
  top-level YIELD → error), `*call`.
- Scope chain with `{v}` ref cells; name resolution → locals else
  `index(I.globals, name)`.
- `evalExpr` for: literals, Name, Paren, Binop (delegate to runtime `arith`/
  `compare`/`concat`; `and`/`or` short-circuit lazily), Unop (`-`→arith unm,
  `not`→truthy, `#`→len), TableExpr (positional counting + last-item
  expansion + rec fields), VarargExpr; `evalMulti` per spec.
- Minimal statements so chunks run: `execBlock` handling ReturnStat (+ its
  multivalue/tailcall rule can wait until T12 — plain return now), LocalStat,
  CallStat, AssignStat (Name + Index targets), plus a provisional closureCall
  (param binding done properly in T12 may refine) registered via
  `setClosureCall`.
- Statement error positioning + RangeError→'stack overflow' wrapper.
- Acceptance `scratch/accept-T10.mjs`: `I.run('return ...')` for ~25 cases:
  `return 1+2*3` → [7]; `return "a".."b"` ; `local t={1,2,x=3} return #t, t.x`;
  `local a,b = 1 return a,b` → [1, undefined]; `return (function() return 1,2 end)()`
  → [1,2]; `return ((function() return 1,2 end)())` → [1]; metatable __add via
  setmetatable? (no stdlib yet — build the table via a native injected into
  globals or skip metamethod e2e until T15).

### T11 — Control-flow statements
**File:** `src/interp.js` · **Depends:** T10 · **Spec:** evaluator section
- DoStat, IfStat, WhileStat, RepeatStat (condition in body scope), BreakStat
  completions; nested-loop break; truthiness rules.
- Acceptance: loops computing values (`while`, `repeat` incl. condition seeing
  body local: `local i=0 repeat local done=i>2 i=i+1 until done return i`),
  if/elseif/else chains, `break` from nested constructs.

### T12 — Functions: closures, varargs, multiple returns, tail calls
**File:** `src/interp.js` · **Depends:** T11 · **Spec:** evaluator + tail calls
- Full `closureCall` with the tail-call loop; ReturnStat→tailcall completion
  rule (exactly one Call/MethodCall expr, not parenthesized); param binding;
  vararg storage visible in nested blocks of the same function only;
  LocalFuncStat self-recursion; MethodCallExpr (obj evaluated once); FuncExpr
  closures capturing ref cells; AssignStat multi-target evaluation order
  (evaluate all RHS first).
- Acceptance: counter-closure pairs sharing upvalues; vararg forwarding
  `function f(...) return g(...) end`; `select`-free vararg counting via
  `local n = #{...}`(table); **tail call: `local function loop(n) if n==0 then return 'done' end return loop(n-1) end return loop(1e6)`
  completes**; non-tail recursion depth ~1e5 throws 'stack overflow' (caught).

### T13 — for loops and goto
**File:** `src/interp.js` · **Depends:** T12 · **Spec:** evaluator section
- NumForStat (coercion errors with exact messages; fractional/negative steps;
  step 0 = infinite loop allowed — test with break; fresh binding per
  iteration), GenForStat (callValue-driven; stops on nil), GotoStat/LabelStat
  completions with the spec's label-scan semantics (incl. `goto continue`
  pattern where the label is the last statement of the loop body).
- Acceptance: numeric for batteries (`for i=1,3`, `=3,1,-1`, `=1,2,.5`),
  closures created in loop bodies capture distinct `i` (collect into a table,
  call later), generic for over a hand-rolled stateless iterator native,
  goto-continue summing odds, backward goto loop, goto out of nested blocks.

### T14 — Coroutine library
**File:** `src/lib/coroutine.js` (new) · **Depends:** T12 · **Spec:** "Coroutines"
- `install(I)` default export; create/resume/yield/status/wrap/running exactly
  per spec (I.coStack, status transitions, dead/non-suspended resume returns,
  error capture, wrap rethrow, nested coroutines).
- Acceptance: value passing both directions across resume/yield; status
  observed from inside (running) and outside (suspended/dead); a coroutine
  resuming another (statuses 'normal'/'running'); error inside coroutine →
  `resume` returns false+message and status dead; wrap in a generic-for as
  iterator; yield across a pcall? (skip — pcall lands in T16; add the case to
  T16's acceptance instead: luajit 5.1 CANNOT yield across pcall — verify
  oracle behavior `luajit -e 'co=coroutine.wrap(function() pcall(coroutine.yield) end) print(pcall(co))'`
  and match what it prints).

## Phase 5 — Standard library (independent files; differential testing unlocked at T15)

### T15 — base library, part 1
**File:** `src/lib/base.js` (new) · **Depends:** T13 · **Spec:** base.js section
- `install(I)` with: print, type, tostring, tonumber, ipairs, pairs, next,
  select, rawget, rawset, rawequal, rawlen, _G, _VERSION. (Leave part-2
  functions for T16 — same file, ordered.)
- Acceptance `scratch/accept-T15.mjs`: first end-to-end differential run!
  Helper `runBoth(luaSrc)` → [v8lua stdout via Interp+install with captured
  stdout, luajit stdout via execFileSync] assert equal. ~20 snippets: print
  formatting (tab separation, numbers via %.14g), type() of everything,
  select('#',...), select(-1,...), ipairs stops at nil, pairs over pure-array
  table, tonumber bases, rawget/rawset vs metatables (install a metatable by…
  setmetatable is T16 — restrict snippets to part-1 functions only).

### T16 — base library, part 2
**File:** `src/lib/base.js` · **Depends:** T15 · **Spec:** base.js section
- setmetatable/getmetatable (__metatable protection), assert, error (level
  0/1 semantics), pcall/xpcall (+extra args), unpack, collectgarbage stub,
  load/loadstring (string + function chunks), loadfile/dofile (node:fs).
- Acceptance: differential snippets — pcall catching arith/index errors and
  printing `select(2, pcall(...))` with `error(msg, 0)` for portable messages;
  error with table values through pcall (identity preserved: `print(t==e)`);
  xpcall handler receiving message; metatable e2e: __index/__newindex/__add/
  __call/__tostring/__eq/__lt now fully testable differentially; the
  yield-across-pcall oracle case from T14.

### T17 — string library: basics
**File:** `src/lib/string.js` (new) · **Depends:** T15 · **Spec:** string.js section
- `install(I)` registering the table + `setStringLibrary`; len, sub, upper,
  lower, rep, reverse, byte, char with Lua index rules (negatives, clamping)
  and numeric-string coercions. Leave find/match/gmatch/gsub/format as
  errors-if-called stubs (replaced by T19/T20 — same file, ordered).
- Acceptance: differential battery incl. `("abc"):sub(-2)`, `sub(2,-2)`,
  `sub(0)`, `byte('A')`, `string.rep('ab',3)`, method syntax on literals,
  `("%d"):len()`, upper/lower on mixed strings.

### T18 — Lua pattern matcher core (pure JS, no Lua plumbing)
**File:** `src/lib/lpattern.js` (new) · **Depends:** — (parallel-safe) ·
**Spec:** string.js pattern section
- Export exactly:
  `match(s, pat, init)` → `null` or
  `{ start, end, captures: Array<string|number> }` (0-based JS indices for
  start/end-exclusive; captures hold strings, or 1-based numbers for position
  captures) — and `MAXCAPTURES = 32`. Pure string/JS-number code, port of
  lstrlib.c matcher: classes, sets, quantifiers (greedy/lazy backtracking),
  `^` handled by caller? NO — handle `^` inside: anchored match only at init.
  `$`, `%bxy`, `%f[set]`, backrefs `%1..%9`, position captures, nesting.
  Malformed patterns throw `LuaError` with luajit's messages (check oracle:
  `malformed pattern (ends with '%')`, `malformed pattern (missing ']')`,
  `invalid pattern capture`, `unfinished capture`).
- Acceptance `scratch/accept-T18.mjs`: table-driven ~60 cases; expected values
  derived live from luajit via
  `luajit -e 'print(string.find(s, p))'`-style probes (write the driver once);
  include: `("abc"):match"()b()"`, `%bxy` nesting, `%f[%w]` at string start,
  backref `(a+)%1`, lazy `-` vs greedy `*`, sets with `]` first, `[%]]`? —
  whatever luajit accepts, match it.

### T19 — string library: pattern functions
**File:** `src/lib/string.js` · **Depends:** T17, T18 · **Spec:** string.js section
- find (init/negative/clamp, plain mode), match, gmatch (empty-match
  advance), gsub (string repl with %0-%9/%%/invalid-% error; table repl;
  function repl via `yield* callValue` honoring nil/false→original; n limit;
  returns [result, count]) — all on top of `lpattern.js`, converting indices
  1-based and captures (whole match when no captures).
- Acceptance: differential battery ~30 snippets (the ones from SPEC's
  string.js section plus gsub with each repl kind, gmatch loop collecting,
  anchored gsub `^`, init beyond length, plain find of magic chars).

### T20 — string.format
**File:** `src/lib/string.js` · **Depends:** T17 · **Spec:** string.format section
- Hand-written printf: %d %i %u %c %x %X %o %e %E %f %g %G %s %q %% with
  flags `-+ #0` space, width, precision; %d truncation toward zero; exponent
  ≥2 digits; %s via tostringMM (generator!); %q exactly per oracle
  (`luajit -e [[io.write(string.format("%q", "a\nb\"c\\d\0e"))]]` — match).
- Acceptance: differential battery ~40 format calls (every directive × flags/
  width/precision combos, `%5.2f`, `%-5d|`, `%05d`, `%#x`, `%+d`, `%g` on
  1e-5/123456789/0.0001/1e20, `%c` of 65, `%q` roundtrip via loadstring once
  T16 done — keep that one in tests/, not here).

### T21 — table library
**File:** `src/lib/table.js` (new) · **Depends:** T15 · **Spec:** table.js section
- insert (arg-count strictness), remove, concat (sep/i/j + exact error msg),
  sort (generator merge-or-quick sort via `yield* callValue` comparator;
  default lt), maxn, unpack (+ coordinate: also set global `unpack` here?
  NO — base.js owns the global; table.js sets only `table.unpack` to the same
  behavior).
- Acceptance: differential — insert/remove at ends and middle, concat with
  seps, sort numbers/strings/custom comparator (stable not required; print
  sorted result), sort with comparator erroring → pcall'd message, maxn with
  holes/non-integer keys.

### T22 — math library
**File:** `src/lib/math.js` (new) · **Depends:** T15 · **Spec:** math.js section
- Full list; mulberry32 PRNG for random/randomseed (deterministic but NOT
  compared to luajit — acceptance asserts ranges/integrality only); modf/fmod
  sign semantics; atan 2-arg; log 2-arg; huge/pi; min/max argument errors.
- Acceptance: differential for everything except random (floor/ceil on
  negatives/.5s, fmod(-5,3) vs %, modf(-3.7), abs(-0) printing, huge
  arithmetic, deg/rad roundtrip via %.10g format); local asserts for random.

### T23 — os and io libraries
**Files:** `src/lib/os.js`, `src/lib/io.js` (new) · **Depends:** T15 · **Spec:** os/io sections
- Per spec. os.date strftime subset + '*t'/'!*t'; os.time(table); clock
  monotonic-float.
- Acceptance: differential with FIXED times only:
  `os.time{year=2000,month=1,day=1,hour=0}` (beware TZ — set TZ=UTC env for
  BOTH sides in the script and use '!' formats), `os.date('!%Y-%m-%d %H:%M:%S', 0)`,
  `os.date('!*t', 86400).yday`, difftime; io.write number formatting; io.read
  smoke-tested by piping stdin to a child `bin/v8lua.js` run.

## Phase 6 — Conformance tests and integration

### T24 — Differential test runner
**File:** `tests/run.js` (new) · **Depends:** T16 · **Spec:** "Determinism & test protocol"
- Implement exactly per spec (oracle luajit, in-process subject via
  `Interp` + `installStdlib` from `../src/stdlib.js`, `--only`, `--update`,
  expected-file fallback, exit codes, per-test PASS/FAIL + summary).
- Acceptance: create `tests/lua/00-smoke.lua` (print arithmetic + a closure +
  a gsub) and show `node tests/run.js` → `1 passed, 0 failed`; `--only nosuch`
  → runs nothing gracefully.

### T25 — Conformance tests: core language
**Files:** `tests/lua/01..08-*.lua` (8 files, names per SPEC test list) ·
**Depends:** T24 (+T19, T21 for the table/pattern files) 
- Write the 8 files per the SPEC/T-list themes (literals, arith, control,
  functions incl. 1e5 tail calls, tables, metatables, strings, patterns).
  **Every file must first run cleanly under plain `luajit`** and produce
  deterministic output (no addresses, no line numbers in printed errors, no
  unordered pairs printing — sort keys).
- Acceptance: `node tests/run.js` green on all written files (fix the .lua
  files OR file precise bug reports listing: file, snippet, luajit output,
  v8lua output — if a runtime bug is found, do not paper over it in the test;
  report it in the task summary for a fix task).

### T26 — Conformance tests: stdlib, coroutines, errors, goto
**Files:** `tests/lua/09..16-*.lua` (8 files) · **Depends:** T24 (+T14, T20, T22, T23)
- Themes per SPEC test list: format, coroutines, errors/pcall (portable
  messages only — `error(msg, 0)` pattern), goto, scoping, stdlib edges,
  stress (sieve+memo fib+OOP class+coroutine pipeline with checksums), load/
  loadstring. Same oracle-first rule, same acceptance as T25.

### T27 — Integration pass
**Files:** any (fix-ups) · **Depends:** T25, T26
- Run `npm test`; fix remaining drift (typical: export-name mismatches,
  forgotten yield*, error-message diffs). Verify `bin/v8lua.js`:
  `echo 'print("hi", 1+1)' | node bin/v8lua.js`, `node bin/v8lua.js -e 'print(_VERSION)'`,
  REPL echo (`printf '1+2\nlocal x=3\nx*2\n' | node bin/v8lua.js -i`),
  `node bin/v8lua.js tests/lua/15-stress.lua`. Verify `src/index.js` exports
  work (`runSource('return 1+1')` → [2]).
- Acceptance: full `npm test` green; CLI checks above produce expected output;
  `node --check` clean on every src/bin/tests file.

### T28 — Docs and release commit
**Files:** `README.md`, `.gitignore` · **Depends:** T27
- README: what it is (Lua 5.1 + goto on V8), install/usage (CLI, REPL, embed
  API), architecture map (file → role), semantics notes (doubles-only numbers,
  strings as UTF-16 code units, %.14g, tail calls, coroutines via generators),
  test instructions, known limitations (no io file handles, no string.dump,
  no os.setlocale, …). `.gitignore`: `node_modules/`, `scratch/`.
- Commit everything (message summarizing; one commit is fine).

---

## Suggested execution waves (maximal safe parallelism)

| Wave | Tasks (parallel within a wave) |
|------|-------------------------------|
| 1 | T01, T05, T18 |
| 2 | T02, T06 |
| 3 | T03, T07 |
| 4 | T04, T08 |
| 5 | T09 |
| 6 | T10 |
| 7 | T11 |
| 8 | T12 |
| 9 | T13, T14 |
| 10 | T15 |
| 11 | T16, T17, T21, T22, T23 |
| 12 | T19, T20, T24 |
| 13 | T25, T26 |
| 14 | T27 |
| 15 | T28 |

(The runtime/interp/parser chains are sequential because they edit one file;
everything else parallelizes. T18 can start immediately — it is pure JS.)
