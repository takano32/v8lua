# v8lua — Lua on V8: Implementation Specification

v8lua is a Lua interpreter written in plain modern JavaScript (ESM), running on
Node.js (V8). Target semantics: **Lua 5.1 plus `goto`/labels (5.2)**. The
reference oracle for behavior is the `luajit` binary (Lua 5.1 semantics).

This document is the **binding contract** between modules. Every module must
follow the exact names, signatures, and data shapes given here. Do not invent
alternative shapes. Plain JavaScript only — **no TypeScript syntax**, no
external dependencies, Node >= 18.

## File layout

```
package.json          { "type": "module", "bin": { "v8lua": "bin/v8lua.js" } }
bin/v8lua.js          CLI + REPL (written during integration; do not write)
src/lexer.js          tokenizer
src/parser.js         tokens -> AST
src/runtime.js        values, LuaTable, errors, metamethod-aware operations
src/interp.js         Interp class: evaluator (generator-based), call protocol
src/index.js          public API (written during integration; do not write)
src/stdlib.js         assembles stdlib (written during integration; do not write)
src/lib/base.js       base library
src/lib/string.js     string library incl. full Lua pattern engine
src/lib/table.js      table library
src/lib/math.js       math library
src/lib/os.js         os library
src/lib/io.js         io library (minimal)
src/lib/coroutine.js  coroutine library
tests/run.js          test runner (differential vs luajit + expected files)
tests/lua/*.lua       test programs (deterministic stdout)
```

## Value representation

| Lua type  | JS representation |
|-----------|-------------------|
| nil       | `undefined` |
| boolean   | `true` / `false` |
| number    | JS `number` (Lua 5.1: all numbers are doubles) |
| string    | JS `string` (treated as code units; byte==code unit for ASCII) |
| table     | `LuaTable` instance |
| function  | `LuaClosure` or `NativeFunction` instance |
| thread    | `LuaCoroutine` instance |

Truthiness: only `nil` and `false` are falsy: `truthy(v) := v !== undefined && v !== false`.

## src/runtime.js — exact exports

```js
export class LuaError extends Error {
  // luaMessage: the Lua error value (any Lua value, often a string)
  // positioned: boolean — true once "chunk:line:" prefix has been added
  constructor(luaMessage) { ... }   // sets this.luaMessage, this.positioned=false
}

export class LuaTable {
  constructor()            // hash: Map, metatable: undefined, id: incrementing int
  get(k)                   // raw get -> value | undefined. Normalizes -0 key to 0.
                           // nil/NaN key -> undefined (no error on read)
  set(k, v)                // raw set. k===undefined -> throw new LuaError("table index is nil")
                           // Number.isNaN(k) -> throw new LuaError("table index is NaN")
                           // v===undefined -> delete key. Normalizes -0 to 0.
  len()                    // '#': border search. If get(1)===undefined -> 0.
                           // Else find n with get(n)~=nil and get(n+1)==nil by
                           // doubling probe then binary search (Lua unbound search).
  next(k)                  // stateless-ish iteration for `next`/pairs.
                           // next(undefined) -> first pair [k, v] or null when empty.
                           // next(k) -> following pair or null at end.
                           // Throw LuaError("invalid key to 'next'") if k not present
                           // (and not deleted-during-traversal; a simple snapshot
                           // cache {keys, idx, lastKey} is fine; skip keys that were
                           // deleted since the snapshot).
}

export class NativeFunction {
  // fn MUST be a generator function: function*(I, args) -> LuaValue[]
  // I is the Interp instance; args is an array of Lua values.
  constructor(name, fn) { this.name = name; this.fn = fn; }
}

export class LuaClosure {
  // Created only by interp. Fields: proto (FuncExpr AST node), scope (defining
  // Scope), name (string, for errors), interp (Interp instance).
}

export class LuaCoroutine {
  // status: 'suspended' | 'running' | 'normal' | 'dead'
  // fn: the Lua function; it: the driving iterator or null; started: boolean
  constructor(fn) { ... }
}

// --- dependency injection from interp (avoids circular import) ---
export function setClosureCall(genFn)  // genFn: function*(closure, args) -> LuaValue[]
export function setStringLibrary(tbl)  // LuaTable of string lib; used for indexing strings

// --- metamethod-aware operations: ALL are generator functions ---
// (generators so that Lua metamethods may yield across coroutine boundaries)

export function* callValue(f, args)    // -> LuaValue[]
//   LuaClosure -> yield* closureCall(f, args)
//   NativeFunction -> yield* f.fn(f.interpHint ?? currentInterp, args)
//     NOTE: natives need I. Solution: interp stores itself with
//     setCurrentInterp(I) once at construction (single-interp per run is fine;
//     export function setCurrentInterp(I) and use it in callValue).
//   value with metatable __call -> yield* callValue(mm, [f, ...args])
//   else throw LuaError(`attempt to call a ${typeName(f)} value`)

export function* index(obj, key)       // -> value
//   LuaTable: raw get; if undefined and metatable has __index:
//     __index table -> repeat protocol on it; __index function -> call(h,[obj,key])
//   string: index into string library table (setStringLibrary)
//   else if metatable with __index (n/a here) else
//     throw LuaError(`attempt to index a ${typeName(obj)} value`)

export function* newindex(obj, key, val)
//   LuaTable: if raw get(key) !== undefined -> raw set. Else __newindex:
//     table -> repeat on it; function -> call(h,[obj,key,val]); none -> raw set.
//   else throw LuaError(`attempt to index a ${typeName(obj)} value`)

export function* arith(op, a, b)       // op: 'add'|'sub'|'mul'|'div'|'mod'|'pow'|'unm'
//   coerce both via arithToNumber (numbers pass; strings via luaToNumber).
//   If both coercible: compute. mod: a - floor(a/b)*b (Lua semantics, sign of b).
//   pow: Math.pow. unm: b is unused (pass a twice for metamethod lookup like Lua).
//   Else: metamethod __add/__sub/__mul/__div/__mod/__pow/__unm from a then b;
//   call it with (a, b). No metamethod ->
//   throw LuaError(`attempt to perform arithmetic on a ${typeName(badOperand)} value`)
//   (badOperand = the one that is not a number/numeric string).

export function* compare(op, a, b)     // op: 'eq'|'lt'|'le' -> boolean
//   eq: primitive equality first (===, with numbers/strings/bools/nil/objects by
//   identity). If false and both LuaTable with __eq (from either) -> call, truthy().
//   lt/le: both numbers -> numeric; both strings -> JS < / <= (code-unit order);
//   else __lt/__le; le falls back to not lt(b,a) via __lt if no __le.
//   No handler -> throw LuaError(`attempt to compare ${typeName(a)} with ${typeName(b)}`)
//   (when same type: `attempt to compare two ${typeName(a)} values`).

export function* concat(a, b)          // -> string or metamethod result
//   string/number operands -> numberToString for numbers, then JS +.
//   else __concat (a then b) ->
//   throw LuaError(`attempt to concatenate a ${typeName(bad)} value`)

export function* len(v)                // '#'
//   string -> v.length; LuaTable: __len metamethod if present else v.len();
//   else throw LuaError(`attempt to get length of a ${typeName(v)} value`)

export function* tostringMM(v)         // tostring() with __tostring support -> JS string
//   metatable __tostring -> call, must return string (else error
//   "'__tostring' must return a string"). Else luaToDisplayString(v).

// --- plain (non-generator) helpers ---
export function truthy(v)
export function typeName(v)            // 'nil'|'boolean'|'number'|'string'|'table'|'function'|'thread'
export function getMetatable(v)        // LuaTable's metatable; strings -> internal
                                       // string mt {__index: stringlib}; else undefined
export function luaToNumber(v, base)   // number | undefined.
//   numbers pass through (base must be absent). Strings: trim whitespace;
//   base 10 default: decimal int/float, exponent, or 0x hex (integer or hex
//   float 0x1p4); other bases 2..36 digits. Invalid -> undefined.
export function numberToString(n)      // Lua %.14g formatting:
//   NaN -> 'nan'; ±Infinity -> 'inf'/'-inf'; -0 -> '-0';
//   integers with |n| < 1e15 -> plain integer string; else emulate %.14g:
//   toPrecision(14), strip trailing zeros/dot, exponent form 'e+NN'/'e-NN'
//   with at least 2 exponent digits.
export function luaToDisplayString(v)  // no metamethods:
//   nil->'nil', true/'false', numbers via numberToString, strings as-is,
//   table -> `table: 0x${id padded to 8 hex}`, function -> `function: 0x...`
//   (NativeFunction: `function: builtin: ...` is NOT used — keep `function: 0x...`
//   with an id counter shared via a WeakMap), thread -> `thread: 0x...`.
export function setCurrentInterp(I)
export function getCurrentInterp()
```

Error position: `LuaError.luaMessage` starts WITHOUT position. The interpreter
adds `"<chunkname>:<line>: "` prefix exactly once (sets `positioned = true`) when
a LuaError crosses a statement whose line is known — only if `luaMessage` is a
string and `positioned` is false.

## Token format (lexer -> parser)

`tokenize(source, chunkname)` -> `Token[]`, where

```js
Token = { type: 'name'|'number'|'string'|'keyword'|'op'|'eof',
          value: string|number,   // number tokens: numeric value; string tokens: decoded contents
          line: number }          // 1-based line of token start
```

- keywords: and break do else elseif end false for function goto if in local
  nil not or repeat return then true until while
- ops (longest-match): `... .. . == ~= <= >= < > = ( ) { } [ ] ; : :: , + - * / % ^ #`
- comments: `--` line; `--[[ ]]`, `--[==[ ]==]` long comments (any level).
- long strings `[[...]]`, `[==[...]==]`: first newline immediately after the
  opening bracket is skipped; no escape processing.
- short strings `'...'`/`"..."` escapes: `\a \b \f \n \r \t \v \\ \" \' \n(real
  newline -> newline)`, `\ddd` (1-3 decimal digits, <=255), `\xXX` (2 hex), `\z`
  (skip following whitespace). Unknown escape -> error. Unfinished string -> error.
- numbers: `123`, `3.14`, `.5`, `5.`, `1e10`, `1E-2`, `0xFF`, hex floats
  `0x1p4`, `0x.8p1`. Malformed -> error.
- Errors: throw `LuaError` with message `` `${chunkname}:${line}: <msg>` ``
  (positioned = true), e.g. `unfinished string near ...`.

## AST specification (parser -> interp)

`parse(tokens, chunkname)` -> `Chunk`. Every node has `type` and `line`.
The chunk is implicitly a vararg function body.

```
Chunk        { type:'Chunk', body: Block }
Block        { type:'Block', stmts: Stat[] }

LocalStat    { type:'LocalStat', names: string[], exprs: Expr[] }
AssignStat   { type:'AssignStat', targets: (NameExpr|IndexExpr)[], exprs: Expr[] }
CallStat     { type:'CallStat', expr: CallExpr|MethodCallExpr }
DoStat       { type:'DoStat', body: Block }
WhileStat    { type:'WhileStat', cond: Expr, body: Block }
RepeatStat   { type:'RepeatStat', body: Block, cond: Expr }   // cond sees body locals
IfStat       { type:'IfStat', clauses: {cond: Expr, body: Block}[], elseBody: Block|null }
NumForStat   { type:'NumForStat', name: string, start: Expr, limit: Expr,
               step: Expr|null, body: Block }
GenForStat   { type:'GenForStat', names: string[], exprs: Expr[], body: Block }
LocalFuncStat{ type:'LocalFuncStat', name: string, func: FuncExpr } // local function f
BreakStat    { type:'BreakStat' }
GotoStat     { type:'GotoStat', label: string }
LabelStat    { type:'LabelStat', name: string }    // ::name::
ReturnStat   { type:'ReturnStat', exprs: Expr[] }  // only last in block (parser enforces;
                                                   // a ';' may follow)

NilExpr      { type:'NilExpr' }
TrueExpr     { type:'TrueExpr' }
FalseExpr    { type:'FalseExpr' }
NumberExpr   { type:'NumberExpr', value: number }
StringExpr   { type:'StringExpr', value: string }
VarargExpr   { type:'VarargExpr' }                 // '...'
FuncExpr     { type:'FuncExpr', params: string[], isVararg: boolean, body: Block,
               name: string|null }                 // name for error messages if known
NameExpr     { type:'NameExpr', name: string }
IndexExpr    { type:'IndexExpr', obj: Expr, key: Expr }   // a.b => key StringExpr 'b'
ParenExpr    { type:'ParenExpr', expr: Expr }      // (e): truncates multivalue to 1
CallExpr     { type:'CallExpr', func: Expr, args: Expr[] }
MethodCallExpr { type:'MethodCallExpr', obj: Expr, method: string, args: Expr[] }
BinopExpr    { type:'BinopExpr', op, lhs: Expr, rhs: Expr }
               // op: '+','-','*','/','%','^','..','==','~=','<','<=','>','>=','and','or'
UnopExpr     { type:'UnopExpr', op: '-'|'not'|'#', expr: Expr }
TableExpr    { type:'TableExpr', fields: Field[] }
Field        { type:'rec', key: Expr, value: Expr }   // [k]=v and k=v (k=v -> StringExpr key)
             | { type:'item', value: Expr }            // positional
```

Desugarings done by the parser:
- `function a.b.c(...)` -> `AssignStat{targets:[IndexExpr(a.b, "c")], exprs:[FuncExpr]}`
- `function a.b:m(...)` -> same, with `"self"` prepended to params; method name in
  FuncExpr.name.
- `local function f() end` -> LocalFuncStat (name is in scope inside the body).
- call sugar: `f"str"`, `f{...}` -> CallExpr with single StringExpr/TableExpr arg.

Precedence (low to high): `or` < `and` < `< > <= >= ~= ==` < `..` (right) <
`+ -` < `* / %` < unary (`not # -`) < `^` (right; binds tighter than unary on
the left: `-2^2 == -4`, but `2^-2` is valid).

Parser errors: throw LuaError, message `` `${chunkname}:${line}: <msg> near '<tok>'` ``
(positioned = true). Enforce: `break` only inside loops; `...` only in vararg
functions; goto target must exist (visible label in scope at end of parse of the
function — a simple per-function label collection check is fine).

## src/interp.js — exact exports

```js
export class Interp {
  constructor(opts = {})
  //   opts.stdout: (s: string) => void   default: process.stdout.write
  //   opts.stderr: (s: string) => void
  //   opts.chunkname: default 'v8lua'
  //   Creates this.globals = new LuaTable(), sets _G = globals (the stdlib
  //   installer wires the rest). Calls setClosureCall(...) and setCurrentInterp(this).
  globals            // LuaTable
  currentLine        // number — updated before each statement executes
  chunkname          // string of the currently executing chunk

  compile(source, chunkname)       // -> LuaClosure (vararg, chunk scope = fresh
                                   //    top scope whose parent is null; free names
                                   //    resolve to globals). Throws LuaError on
                                   //    syntax errors.
  run(source, chunkname, args=[])  // compile + call to completion (drives the
                                   //    generator; a top-level yield sentinel ->
                                   //    throw LuaError('attempt to yield from
                                   //    outside a coroutine')). -> LuaValue[]
  *call(f, args)                   // generator: yield* callValue(f, args)
}
```

### Evaluator architecture

All evaluation functions are **generator functions** (`function*`), and every
nested evaluation/call uses `yield*`. This is what makes coroutines work: a
`coroutine.yield` deep in a call stack yields a sentinel object up through every
`yield*` frame to the driving `resume` loop.

**Yield sentinel** (defined in runtime.js, used by coroutine lib and drivers):

```js
export const YIELD = Symbol('yield')
// a yield travels as: { [YIELD]: true, values: LuaValue[] }
// coroutine.yield's native fn does:  const sent = {[YIELD]:true, values:args};
//                                    const resumed = yield sent;  return resumed;
```

Intermediate frames never see it (yield* is transparent); only resume drivers
call `.next()` and inspect it.

**Scopes**: `Scope { vars: Map<string, {v: LuaValue}>, parent: Scope|null }`.
Locals are ref cells `{v}` so closures share them. Name resolution walks the
chain; not found -> global access through `index(I.globals, name)` /
`newindex(I.globals, name, v)` (so metatables on _G work). Each block gets a
fresh Scope. Numeric/generic `for` create a **fresh binding per iteration**
(closures in loop bodies capture distinct cells). `repeat`'s condition
evaluates in the body's scope.

**Statement execution** `*execBlock(block, scope)` returns a completion:

```
undefined                                   // normal fall-through
{ type:'break' }
{ type:'return', values: LuaValue[] }
{ type:'tailcall', f, args }                // see tail calls
{ type:'goto', label: string }
```

goto: when execBlock receives a goto completion from a statement, scan the
*current* block's statements for `LabelStat` with that name; if found, continue
execution from the statement after the label (re-entering with a fresh scope for
correctness of locals is acceptable: Lua forbids jumping into a local's scope).
If not found, propagate upward. Loops (`while`/`repeat`/`for`) propagate goto
out of the loop body upward (this also lets `goto continue`-style labels at the
end of the loop body work, since the label is inside the body block).

**Expression evaluation**: `*evalExpr(e, scope) -> LuaValue` (single value;
multivalue expressions truncated to first), and
`*evalMulti(exprs, scope) -> LuaValue[]` which expands the **last** expression
if it is CallExpr/MethodCallExpr/VarargExpr, truncates all others to one value.
ParenExpr always truncates. `and`/`or` short-circuit. Varargs are stored in the
function frame (pass through scopes as a special entry or a frame object —
implementer's choice, but `...` must be visible in nested blocks of the same
function only).

**Calls and tail calls**: `closureCall(closure, args)` (registered via
`setClosureCall`):

```
loop {
  bind params, set up frame scope (parent = closure.scope), varargs
  c = yield* execBlock(closure.proto.body, frameScope)
  if c is return  -> return c.values
  if c is tailcall:
     if c.f is LuaClosure -> closure = c.f; args = c.args; continue loop  // O(1) stack
     else -> return yield* callValue(c.f, c.args)
  otherwise -> return []
}
```

`ReturnStat` whose expr list is exactly one CallExpr/MethodCallExpr (and not
ParenExpr) produces `{type:'tailcall', f, args}` instead of evaluating the call
— this gives proper tail calls (required: a loop of 1e6 tail calls must not
overflow). Note: evaluate `f` and `args` BEFORE producing the completion.

**Error positions**: before executing each statement, set `I.currentLine =
stmt.line`. Wrap statement execution so that a thrown LuaError with
`positioned === false` and string `luaMessage` gets
`` luaMessage = `${chunkname}:${stmt.line}: ${luaMessage}` ``, `positioned = true`,
rethrown. Non-LuaError JS exceptions propagate as-is (they are bugs), EXCEPT
`RangeError` (stack overflow) which should convert to
`LuaError('stack overflow')`.

**Method calls**: `obj:m(args)` -> evaluate obj once, `f = yield* index(obj, m)`,
then `yield* callValue(f, [obj, ...args])`.

**Numeric for**: coerce start/limit/step with `luaToNumber`; non-number ->
LuaError `'for' initial value must be a number` (or `'for' limit ...` /
`'for' step ...`). step 0 is an infinite loop in 5.1 (allowed — do not error).

**Generic for**: `local f, s, var = evalMulti(exprs)`; loop:
`rets = yield* callValue(f, [s, var])`; if `rets[0] === undefined` break;
`var = rets[0]`; bind names to rets.

## Coroutines — src/lib/coroutine.js

Uses `LuaCoroutine` from runtime. Library functions (all NativeFunction
generators):

- `coroutine.create(f)` — f must be a function -> new LuaCoroutine(f), status
  'suspended'.
- `coroutine.resume(co, ...)` — implement the drive loop here:
  - errors if co is not a coroutine; if status 'dead' -> return
    `[false, 'cannot resume dead coroutine']`; 'running' -> `[false, 'cannot
    resume non-suspended coroutine']`.
  - first resume: `co.it = callValue(co.fn, args)` (the generator object);
    subsequent: pass resume args into `co.it.next(args)`.
  - set previous running co (if any) to 'normal', co.status='running', track a
    current-coroutine stack on the Interp (`I.coStack` array is fine).
  - drive ONE step: `r = co.it.next(passVals)`. If `r.done` -> status 'dead',
    return `[true, ...r.value]`. If `r.value && r.value[YIELD]` -> status
    'suspended', return `[true, ...r.value.values]`.
  - if `co.it.next` throws LuaError e -> status 'dead', return
    `[false, e.luaMessage]` (after positioning if string—leave as-is).
  - **Important**: resume itself is a native generator called from arbitrary
    depth; nested coroutines work because each resume drives its own iterator.
- `coroutine.yield(...)` — native generator: `const back = yield
  {[YIELD]:true, values:args}; return back ?? []`.
- `coroutine.status(co)` -> the status string ('running' if co is the current
  one, 'normal' if it has resumed another).
- `coroutine.wrap(f)` -> native that resumes and on `[false, err]` throws
  LuaError(err), else returns values without the boolean.
- `coroutine.running()` -> [co] or [undefined] (5.1: main returns nil).

## Standard library

Each `src/lib/*.js` default-exports `install(I)` (I: Interp). It builds
LuaTables, registers into `I.globals` via `.set(...)`, and returns nothing.
Natives are `new NativeFunction(name, function*(I, args) {...} )` and return an
**array** of Lua values (empty array for none). Use runtime helpers for all
coercions and errors. Argument errors follow Lua format:
`` `bad argument #${n} to '${fname}' (${expected} expected, got ${typeName(got)})` ``.

### base.js
print (tostringMM each, join '\t', + '\n', via I.stdout), type, tostring
(tostringMM), tonumber(v[,base]), ipairs (returns iterator native: stops at
first nil), pairs (respects __pairs? NO — 5.1: just returns [next, t, nil]),
next(t[,k]), select('#'|n, ...) (negative n counts from end), rawget, rawset,
rawequal, rawlen (bonus), setmetatable (errors on non-table mt unless nil;
respects __metatable protection -> error 'cannot change a protected metatable'),
getmetatable (returns __metatable field if present), assert(v[,msg]) (msg
default 'assertion failed!'; passes through all values when truthy),
error(msg[,level]) (level 0: no position; level>=1: prepend
`${I.chunkname}:${I.currentLine}: ` when msg is a string — mark positioned),
pcall(f, ...) -> [true, ...] | [false, errval], xpcall(f, handler, ...)
(5.2-style extra args ok; handler called on error with the error value, runs
in the erroring context), unpack(t[,i[,j]]) (also table.unpack alias),
collectgarbage([opt]) (stub: 'count' -> [0, 0], else [0]), load(chunk[,
chunkname]) (string only; function-chunks: call repeatedly concatenating
strings until nil) -> [closure] or [nil, errmsg], loadstring = load,
dofile(path) (node:fs readFileSync, run as chunk `@path`), loadfile(path),
_G, _VERSION = 'Lua 5.1'.

### string.js — incl. full Lua pattern engine
len, sub(s,i[,j]) (Lua index rules: 1-based, negative from end, clamping),
upper, lower, rep(s,n[,sep]) (sep is 5.2 bonus; n<=0 -> ''), reverse,
byte(s[,i[,j]]) -> code units, char(...), format (see below), and the pattern
functions: find(s,pat[,init[,plain]]), match(s,pat[,init]), gmatch(s,pat),
gsub(s,pat,repl[,n]) where repl is string (with %0-%9 and %%), table, or
function (called with captures; nil/false result -> keep original match).

**Pattern engine** — implement Lua 5.1 patterns exactly (port lstrlib logic):
classes `%a %c %d %l %p %s %u %w %x` and uppercase complements, `.` any, `%<punct>`
escape, sets `[...]` with ranges and `^` negation and classes inside, quantifiers
`* + - ?` (with backtracking; `-` lazy), anchors `^` (only at pattern start) and
`$` (only at end), captures `(...)` (up to 32) including **position captures**
`()` (capture value = number position), back-references `%1`-`%9`, balanced
match `%bxy`, frontier `%f[set]`. find returns [start, end, ...captures]
(1-based, inclusive) or [nil]. match returns captures, or whole match if no
captures. gmatch iterator advances past empty matches correctly (pos+1).
gsub returns [result, count].

Also call `setStringLibrary(stringTable)` so `("x"):upper()` works.

**string.format**: directives `%d %i %u %c %x %X %o %e %E %f %g %G %s %q %%`
with flags `-+ #0 space`, width, precision. `%d` truncates the number toward
zero. `%q` quotes with `\"`, `\\`, `\n` (as `\` + newline), `\r` -> `\r`,
`\0` -> `\0`, other control chars numeric escapes. `%s` applies tostringMM.
Implement printf in JS by hand (no deps). Numbers for %e/%f/%g via
toExponential/toFixed/toPrecision with post-processing (e+05 style exponents:
at least 2 digits).

### table.js
insert(t, [pos,] v) (shifts up; default append at #t+1; wrong arg count ->
error "wrong number of arguments to 'insert'"), remove(t[,pos]) (returns
removed; default #t; shifts down), concat(t[,sep[,i[,j]]]) (elements must be
string/number else error `invalid value (at index N) in table for 'concat'`),
sort(t[,comp]) (in-place; comp via callValue; default lt via compare; use a
simple quicksort or insertion+merge implemented with generators since comp is a
Lua call — copy out to JS array of [v], sort with a hand-written generator
merge sort, write back; "invalid order function" detection not required),
maxn(t) (largest positive numeric key), unpack (same as base unpack).

### math.js
abs ceil floor sqrt sin cos tan asin acos atan(y[,x]) exp log(x[,base — 5.2
bonus]) pow fmod(a,b) (JS % semantics: sign of a — that IS fmod) modf (->
[int part (toward zero, as float), frac]) deg rad random([m[,n]])
(no args: [0,1); m: [1,m]; m,n: [m,n]; integer results) randomseed(x)
(implement a small LCG or mulberry32 so seeding is deterministic; math.random
uses it) huge=Infinity pi max(...) min(...) (at least one arg; numeric
coercion via luaToNumber, error on non-number).

### os.js
clock() (process.hrtime.bigint()/1e9 as float since first call or
process.cpuUsage), time([t]) (no arg: floor(Date.now()/1000); table arg: fields
year month day [hour=12 min=0 sec=0] via Date), date([fmt[,t]]) (default fmt
'%c'; support % a A b B c d H I M m p S w x X Y y %%; leading '*t'/'!*t' ->
table with year month day hour min sec wday yday isdst), difftime(a,b)=a-b,
getenv(name) (process.env), exit([code]) (process.exit; true->0 false->1),
tmpname/remove/rename: omit.

### io.js
io.write(...) (numbers via numberToString, strings as-is; error on other types;
via I.stdout; returns the io table or nothing — return []), io.read([fmt])
(formats 'l'/'*l' line w/o newline, 'n'/'*n' number, 'a'/'*a' rest; read stdin
synchronously via fs.readSync on fd 0 wrapped in try/catch; EOF -> nil. Keep a
module-level buffer.), io.lines([file]) bonus if trivial. Skip file handles.

## Determinism & test protocol

Tests are plain Lua files in `tests/lua/`, printing deterministic output. The
runner `tests/run.js`:

1. For each `tests/lua/*.lua`: run it with `child_process.execFileSync('luajit',
   [file])` to capture the oracle stdout (skip oracle if luajit missing —
   then use `tests/expected/<name>.txt` if present).
2. Run the same file in-process via v8lua's API with a captured stdout.
3. Compare exactly; print a unified PASS/FAIL summary, exit nonzero on failure.
4. `node tests/run.js --only <substr>` filters tests; `--update` writes
   `tests/expected/` snapshots from the oracle.

Tests must avoid: printing table/function addresses, os.time/clock values,
pairs iteration order on mixed tables (iterate ipairs-style or sort keys when
printing), and luajit-specific extensions. `math.random` may be used only with
explicit `math.randomseed` AND must not be compared against the oracle —
instead assert invariants (range checks) and print 'ok'.

## Code conventions

- ESM (`import`/`export`), plain JS, no TS syntax, no dependencies.
- Every file starts with a one-line comment of its role.
- Errors thrown in Lua-land are always `LuaError`. Never throw plain strings.
- Use `yield*` for any call that may run Lua code (metamethods included).
- Performance is secondary to correctness, but avoid quadratic string building
  in hot paths (use arrays + join).
