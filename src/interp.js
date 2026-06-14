// interp.js — generator-based tree-walking evaluator. See docs/SPEC.md
// "src/interp.js — exact exports" and "Evaluator architecture".
import { parse } from './parser.js';
import {
  LuaError, LuaTable, LuaClosure,
  setClosureCall, setCurrentInterp, runToCompletion,
  callValue, index, newindex, arith, compare, concat, len,
  truthy, luaToNumber, typeName, shortSrc,
} from './runtime.js';

// Signature prefixing v8lua's string.dump output. v8lua has no bytecode, so
// dump serializes the AST prototype + upvalue names; loadstring detects this
// header and reconstructs the closure. Starts with ESC like real Lua chunks.
export const DUMP_MAGIC = '\x1bv8luaDump\0';

export class Scope {
  constructor(parent) {
    this.vars = new Map();
    this.parent = parent;
    // function-boundary scopes additionally get a `varargs` own property
    // (array for vararg functions, null otherwise).
  }
}

export function lookup(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    const cell = s.vars.get(name);
    if (cell !== undefined) return cell;
  }
  return null;
}

// Ordered list of a function prototype's free variable names — names referenced
// in its body (including nested closures) that it does not itself bind. This is
// the candidate upvalue list; order follows Lua's first-resolution order
// (assignment targets before their right-hand sides). Memoized on the proto.
export function freeVarNames(proto) {
  if (proto._freeVars) return proto._freeVars;
  const out = [];
  const seen = new Set();
  const stack = []; // array of Sets, innermost last
  const bound = (name) => stack.some((s) => s.has(name));
  const ref = (name) => { if (!bound(name) && !seen.has(name)) { seen.add(name); out.push(name); } };

  function pushScope() { stack.push(new Set()); }
  function popScope() { stack.pop(); }
  function declare(name) { stack[stack.length - 1].add(name); }

  function walkBlock(block) {
    pushScope();
    for (const st of block.stmts) walkStat(st);
    popScope();
  }

  function walkStat(st) {
    switch (st.type) {
      case 'LocalStat':
        for (const e of st.exprs) walkExpr(e);
        for (const n of st.names) declare(n);
        break;
      case 'LocalFuncStat':
        declare(st.name);
        walkExpr(st.func);
        break;
      case 'AssignStat':
        for (const t of st.targets) walkExpr(t);
        for (const e of st.exprs) walkExpr(e);
        break;
      case 'CallStat': walkExpr(st.expr); break;
      case 'DoStat': walkBlock(st.body); break;
      case 'IfStat':
        for (const c of st.clauses) { walkExpr(c.cond); walkBlock(c.body); }
        if (st.elseBody) walkBlock(st.elseBody);
        break;
      case 'WhileStat': walkExpr(st.cond); walkBlock(st.body); break;
      case 'RepeatStat':
        // until-condition sees the body's locals
        pushScope();
        for (const s of st.body.stmts) walkStat(s);
        walkExpr(st.cond);
        popScope();
        break;
      case 'NumForStat':
        walkExpr(st.start); walkExpr(st.limit); if (st.step) walkExpr(st.step);
        pushScope(); declare(st.name);
        for (const s of st.body.stmts) walkStat(s);
        popScope();
        break;
      case 'GenForStat':
        for (const e of st.exprs) walkExpr(e);
        pushScope(); for (const n of st.names) declare(n);
        for (const s of st.body.stmts) walkStat(s);
        popScope();
        break;
      case 'ReturnStat': for (const e of st.exprs) walkExpr(e); break;
      default: break; // Break/Goto/Label: no names
    }
  }

  function walkExpr(e) {
    if (e == null) return;
    switch (e.type) {
      case 'NameExpr': ref(e.name); break;
      case 'ParenExpr': walkExpr(e.expr); break;
      case 'IndexExpr': walkExpr(e.obj); walkExpr(e.key); break;
      case 'CallExpr': walkExpr(e.func); for (const a of e.args) walkExpr(a); break;
      case 'MethodCallExpr': walkExpr(e.obj); for (const a of e.args) walkExpr(a); break;
      case 'BinopExpr': walkExpr(e.lhs); walkExpr(e.rhs); break;
      case 'UnopExpr': walkExpr(e.expr); break;
      case 'TableExpr':
        for (const f of e.fields) {
          if (f.type === 'rec') walkExpr(f.key);
          walkExpr(f.value);
        }
        break;
      case 'FuncExpr':
        pushScope();
        for (const p of e.params) declare(p);
        for (const s of e.body.stmts) walkStat(s);
        popScope();
        break;
      default: break; // literals, vararg
    }
  }

  pushScope();
  for (const p of proto.params) declare(p);
  for (const st of proto.body.stmts) walkStat(st);
  popScope();
  proto._freeVars = out;
  return out;
}

// A closure's upvalues: free variable names that resolve to a cell in an
// enclosing scope (names that resolve to nothing are globals, not upvalues).
export function closureUpvalues(closure) {
  const ups = [];
  for (const name of freeVarNames(closure.proto)) {
    const cell = lookup(closure.scope, name);
    if (cell !== null) ups.push({ name, cell });
  }
  return ups;
}

function findVarargs(scope) {
  for (let s = scope; s !== null; s = s.parent) {
    if (Object.prototype.hasOwnProperty.call(s, 'varargs')) return s.varargs;
  }
  return null;
}

const ARITH_OP = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '^': 'pow' };

// The closure-call protocol, registered into the runtime. Implements proper
// tail calls: a tailcall completion to another LuaClosure rebinds the loop
// frame instead of growing the JS stack.
function* closureCall(closure, args) {
  const I = closure.interp;
  const frame = { closure, line: closure.proto.line || 0 };
  frame.callName = I._pendingName;   // how the caller named this function (for debug.getinfo "n")
  frame.callKind = I._pendingKind;
  I._pendingName = undefined;
  I._pendingKind = undefined;
  I.frames.push(frame);
  try {
    for (;;) {
      const proto = closure.proto;
      const scope = new Scope(closure.scope);
      for (let i = 0; i < proto.params.length; i++) {
        scope.vars.set(proto.params[i], { v: args[i] });
      }
      const extra = proto.isVararg ? args.slice(proto.params.length) : null;
      scope.varargs = extra;
      if (proto.needsArg) {
        // Lua 5.1 implicit 'arg' table: extra args at 1..n plus arg.n = count.
        const argT = new LuaTable();
        for (let i = 0; i < extra.length; i++) argT.set(i + 1, extra[i]);
        argT.set('n', extra.length);
        scope.vars.set('arg', { v: argT });
      }
      const savedChunk = I.chunkname;
      if (closure.chunkname !== undefined) I.chunkname = closure.chunkname;
      let c;
      try {
        c = yield* I.execBlock(proto.body, scope);
      } finally {
        I.chunkname = savedChunk;
      }
      if (c === undefined) return [];
      if (c.type === 'return') return c.values;
      if (c.type === 'tailcall') {
        if (c.f instanceof LuaClosure) {
          closure = c.f;
          frame.closure = closure; // tail call replaces the activation
          args = c.args;
          continue;
        }
        return yield* callValue(c.f, c.args);
      }
      // goto with no matching label anywhere in the function body
      throw new LuaError(`no visible label '${c.label}' for goto`);
    }
  } finally {
    I.frames.pop();
  }
}

export class Interp {
  constructor(opts = {}) {
    // Lua strings are byte strings; v8lua holds each byte as a char (0-255), so
    // output is encoded latin1 to be byte-accurate rather than re-encoded UTF-8.
    this.stdout = opts.stdout ?? ((s) => process.stdout.write(Buffer.from(s, 'latin1')));
    this.stderr = opts.stderr ?? ((s) => process.stderr.write(Buffer.from(s, 'latin1')));
    this.chunkname = opts.chunkname ?? 'v8lua';
    this.globals = new LuaTable();
    this.globals.set('_G', this.globals);
    this.genv = this.globals; // thread global environment (setfenv(0,...) changes it)
    this.frames = [];          // stack of executing LuaClosures (for getfenv/setfenv levels)
    this.currentLine = 0;
    this.coStack = []; // running coroutines, innermost last
    this.hook = null;   // debug hook: { fn, line, call, ret, mask } or null
    this.inHook = false;
    this._handlerFrames = undefined; // error stack snapshot for an xpcall handler
    this._pendingName = undefined;
    this._pendingKind = undefined;
    setCurrentInterp(this);
    setClosureCall(closureCall);
  }

  // `source` is a string or a reader function (pulled lazily during parsing).
  compile(source, chunkname = this.chunkname) {
    const ast = parse(source, chunkname);
    const proto = {
      type: 'FuncExpr', params: [], isVararg: true,
      body: ast.body, name: chunkname, line: 0,
    };
    const closure = new LuaClosure(proto, null, chunkname, this);
    closure.chunkname = chunkname;
    closure.env = this.genv; // loaded chunks run in the thread global environment
    return closure;
  }

  // Environment of the currently executing Lua function (for global name
  // resolution); falls back to the thread global environment at top level.
  currentEnv() {
    const n = this.frames.length;
    return n > 0 ? this.frames[n - 1].closure.env : this.genv;
  }

  run(source, chunkname = this.chunkname, args = []) {
    setCurrentInterp(this);
    setClosureCall(closureCall);
    const closure = this.compile(source, chunkname);
    return runToCompletion(callValue(closure, args));
  }

  *call(f, args) {
    return yield* callValue(f, args);
  }

  // Run the installed debug hook, guarding against re-entry.
  *fireHook(event, line) {
    if (this.hook === null || this.inHook) return;
    this.inHook = true;
    try {
      yield* callValue(this.hook.fn, line === undefined ? [event] : [event, line]);
    } finally {
      this.inHook = false;
    }
  }

  // 'local' | 'upvalue' | 'global' classification for error messages.
  _varKind(scope, name) {
    let crossed = 0;
    for (let s = scope; s !== null; s = s.parent) {
      if (s.vars.has(name)) return crossed === 0 ? 'local' : 'upvalue';
      if (Object.prototype.hasOwnProperty.call(s, 'varargs')) crossed++;
    }
    return 'global';
  }

  // Describe an expression for Lua-style error messages ("local 'x'",
  // "field 'y'") or null when no useful name exists.
  _describeExpr(e, scope) {
    if (e == null) return null;
    if (e.type === 'ParenExpr') return this._describeExpr(e.expr, scope);
    if (e.type === 'NameExpr') return `${this._varKind(scope, e.name)} '${e.name}'`;
    if (e.type === 'IndexExpr' && e.key.type === 'StringExpr') return `field '${e.key.value}'`;
    return null;
  }

  // Enrich "attempt to <verb> a T value" with the operand's name, matching
  // PUC-Lua/LuaJIT message style.
  _decorate(err, verb, desc, val) {
    if (desc !== null && err instanceof LuaError && !err.positioned &&
        err.luaMessage === `attempt to ${verb} a ${typeName(val)} value`) {
      err.luaMessage = `attempt to ${verb} ${desc} (a ${typeName(val)} value)`;
    }
    return err;
  }

  // Add "chunk:line:" to a stray error exactly once; convert JS stack overflow.
  _position(e, line) {
    if (e instanceof RangeError) {
      e = new LuaError('stack overflow');
    }
    if (e instanceof LuaError && !e.positioned) {
      if (typeof e.luaMessage === 'string') {
        e.luaMessage = `${shortSrc(this.chunkname)}:${line}: ${e.luaMessage}`;
      }
      e.positioned = true;
    }
    // Snapshot the call stack the first time the error is seen (frames are still
    // intact here) so an xpcall message handler can produce a real traceback —
    // JS try/catch has already unwound the stack by the time the handler runs.
    if (e instanceof LuaError && e._frames === undefined) {
      const n = this.frames.length;
      const cap = Math.min(n, 2200);
      const snap = new Array(cap);
      for (let i = 0; i < cap; i++) {
        const fr = this.frames[n - 1 - i]; // innermost first
        snap[i] = {
          src: shortSrc(fr.closure.chunkname),
          line: fr.line,
          name: fr.callName,
          main: (fr.closure.proto.line || 0) === 0,
        };
      }
      e._frames = snap;
    }
    return e;
  }

  // ---------- statements ----------

  *execBlock(block, scope) {
    const stmts = block.stmts;
    let i = 0;
    while (i < stmts.length) {
      const c = yield* this.execStat(stmts[i], scope);
      if (c !== undefined) {
        if (c.type === 'goto') {
          const at = stmts.findIndex((s) => s.type === 'LabelStat' && s.name === c.label);
          if (at >= 0) {
            i = at + 1;
            continue;
          }
        }
        return c;
      }
      i++;
    }
    return undefined;
  }

  *execStat(stmt, scope) {
    const top = this.frames[this.frames.length - 1];
    const prevLine = top !== undefined ? top.line : -1;
    this.currentLine = stmt.line;
    if (top !== undefined) top.line = stmt.line; // for error()/debug level walking
    // debug line hook: fire when execution moves to a different line.
    if (this.hook !== null && this.hook.line && !this.inHook && stmt.line !== prevLine) {
      yield* this.fireHook('line', stmt.line);
    }
    try {
      return yield* this.execStatInner(stmt, scope);
    } catch (e) {
      throw this._position(e, stmt.line);
    }
  }

  *execStatInner(stmt, scope) {
    switch (stmt.type) {
      case 'LocalStat': {
        const vals = yield* this.evalMulti(stmt.exprs, scope);
        for (let i = 0; i < stmt.names.length; i++) {
          scope.vars.set(stmt.names[i], { v: vals[i] });
        }
        return;
      }
      case 'LocalFuncStat': {
        const cell = { v: undefined };
        scope.vars.set(stmt.name, cell);
        const f = new LuaClosure(stmt.func, scope, stmt.name, this);
        f.chunkname = this.chunkname;
        f.env = this.currentEnv(); // inherit the creating function's environment
        cell.v = f;
        return;
      }
      case 'AssignStat': {
        // Lua evaluates all target table/key subexpressions BEFORE the RHS and
        // before any store, so later stores can't perturb earlier targets.
        const refs = [];
        for (const t of stmt.targets) {
          if (t.type === 'NameExpr') {
            refs.push({ name: t.name, cell: lookup(scope, t.name) });
          } else {
            const obj = yield* this.evalExpr(t.obj, scope);
            const key = yield* this.evalExpr(t.key, scope);
            refs.push({ obj, key, descExpr: t.obj });
          }
        }
        const vals = yield* this.evalMulti(stmt.exprs, scope);
        for (let i = 0; i < refs.length; i++) {
          const r = refs[i];
          const v = vals[i];
          if (r.name !== undefined) {
            if (r.cell !== null) r.cell.v = v;
            else yield* newindex(this.currentEnv(), r.name, v);
          } else {
            try {
              yield* newindex(r.obj, r.key, v);
            } catch (err) {
              throw this._decorate(err, 'index', this._describeExpr(r.descExpr, scope), r.obj);
            }
          }
        }
        return;
      }
      case 'CallStat':
        yield* this.evalCall(stmt.expr, scope);
        return;
      case 'DoStat':
        return yield* this.execBlock(stmt.body, new Scope(scope));
      case 'IfStat': {
        for (const clause of stmt.clauses) {
          if (truthy(yield* this.evalExpr(clause.cond, scope))) {
            return yield* this.execBlock(clause.body, new Scope(scope));
          }
        }
        if (stmt.elseBody !== null) {
          return yield* this.execBlock(stmt.elseBody, new Scope(scope));
        }
        return;
      }
      case 'WhileStat': {
        while (truthy(yield* this.evalExpr(stmt.cond, scope))) {
          const c = yield* this.execBlock(stmt.body, new Scope(scope));
          if (c !== undefined) {
            if (c.type === 'break') break;
            return c;
          }
        }
        return;
      }
      case 'RepeatStat': {
        for (;;) {
          const bodyScope = new Scope(scope);
          const c = yield* this.execBlock(stmt.body, bodyScope);
          if (c !== undefined) {
            if (c.type === 'break') break;
            return c;
          }
          // the until-condition sees the body's locals (Lua scoping rule)
          if (truthy(yield* this.evalExpr(stmt.cond, bodyScope))) break;
        }
        return;
      }
      case 'NumForStat': {
        const startV = luaToNumber(yield* this.evalExpr(stmt.start, scope));
        if (startV === undefined) throw new LuaError("'for' initial value must be a number");
        const limitV = luaToNumber(yield* this.evalExpr(stmt.limit, scope));
        if (limitV === undefined) throw new LuaError("'for' limit must be a number");
        let stepV = 1;
        if (stmt.step !== null) {
          stepV = luaToNumber(yield* this.evalExpr(stmt.step, scope));
          if (stepV === undefined) throw new LuaError("'for' step must be a number");
        }
        for (let i = startV; stepV > 0 ? i <= limitV : i >= limitV; i += stepV) {
          const iterScope = new Scope(scope);
          iterScope.vars.set(stmt.name, { v: i }); // fresh cell per iteration
          const c = yield* this.execBlock(stmt.body, iterScope);
          if (c !== undefined) {
            if (c.type === 'break') break;
            return c;
          }
        }
        return;
      }
      case 'GenForStat': {
        const init = yield* this.evalMulti(stmt.exprs, scope);
        const f = init[0];
        const s = init[1];
        let control = init[2];
        // Lua attributes the iterator call to the line of the 'in' expressions.
        const iterLine = stmt.exprs[stmt.exprs.length - 1].line;
        for (;;) {
          let rets;
          try {
            rets = yield* callValue(f, [s, control]);
          } catch (err) {
            throw this._position(err, iterLine);
          }
          if (rets[0] === undefined) break;
          control = rets[0];
          const iterScope = new Scope(scope);
          for (let i = 0; i < stmt.names.length; i++) {
            iterScope.vars.set(stmt.names[i], { v: rets[i] });
          }
          const c = yield* this.execBlock(stmt.body, iterScope);
          if (c !== undefined) {
            if (c.type === 'break') break;
            return c;
          }
        }
        return;
      }
      case 'ReturnStat': {
        if (stmt.exprs.length === 1) {
          const e = stmt.exprs[0];
          if (e.type === 'CallExpr' || e.type === 'MethodCallExpr') {
            // proper tail call: evaluate callee+args, defer the call itself
            const prepared = yield* this.prepareCall(e, scope);
            return { type: 'tailcall', f: prepared.f, args: prepared.args };
          }
        }
        return { type: 'return', values: yield* this.evalMulti(stmt.exprs, scope) };
      }
      case 'BreakStat':
        return { type: 'break' };
      case 'GotoStat':
        return { type: 'goto', label: stmt.label };
      case 'LabelStat':
        return;
      default:
        throw new LuaError(`unhandled statement type ${stmt.type}`);
    }
  }

  // ---------- expressions ----------

  *prepareCall(e, scope) {
    if (e.type === 'MethodCallExpr') {
      const obj = yield* this.evalExpr(e.obj, scope);
      let f;
      try {
        f = yield* index(obj, e.method);
      } catch (err) {
        throw this._decorate(err, 'index', this._describeExpr(e.obj, scope), obj);
      }
      const args = [obj, ...yield* this.evalMulti(e.args, scope)];
      return { f, args };
    }
    const f = yield* this.evalExpr(e.func, scope);
    const args = yield* this.evalMulti(e.args, scope);
    return { f, args };
  }

  *evalCall(e, scope) {
    const { f, args } = yield* this.prepareCall(e, scope);
    // Record how this call names its target, for debug.getinfo(level, "n").
    if (e.type === 'MethodCallExpr') {
      this._pendingName = e.method;
      this._pendingKind = 'method';
    } else if (e.func.type === 'NameExpr') {
      this._pendingName = e.func.name;
      this._pendingKind = this._varKind(scope, e.func.name);
    } else if (e.func.type === 'IndexExpr' && e.func.key.type === 'StringExpr') {
      this._pendingName = e.func.key.value;
      this._pendingKind = 'field';
    } else {
      this._pendingName = undefined;
      this._pendingKind = undefined;
    }
    try {
      return yield* callValue(f, args);
    } catch (err) {
      const desc = e.type === 'MethodCallExpr'
        ? `method '${e.method}'`
        : this._describeExpr(e.func, scope);
      throw this._decorate(err, 'call', desc, f);
    }
  }

  // Evaluate an expression list with last-position multivalue expansion.
  *evalMulti(exprs, scope) {
    const out = [];
    for (let i = 0; i < exprs.length; i++) {
      const e = exprs[i];
      const isLast = i === exprs.length - 1;
      if (isLast && (e.type === 'CallExpr' || e.type === 'MethodCallExpr')) {
        out.push(...yield* this.evalCall(e, scope));
      } else if (isLast && e.type === 'VarargExpr') {
        out.push(...(findVarargs(scope) ?? []));
      } else {
        out.push(yield* this.evalExpr(e, scope));
      }
    }
    return out;
  }

  *evalExpr(e, scope) {
    switch (e.type) {
      case 'NilExpr': return undefined;
      case 'TrueExpr': return true;
      case 'FalseExpr': return false;
      case 'NumberExpr': return e.value;
      case 'StringExpr': return e.value;
      case 'VarargExpr': {
        const va = findVarargs(scope);
        return va === null ? undefined : va[0];
      }
      case 'NameExpr': {
        const cell = lookup(scope, e.name);
        if (cell !== null) return cell.v;
        return yield* index(this.currentEnv(), e.name);
      }
      case 'ParenExpr':
        return yield* this.evalExpr(e.expr, scope);
      case 'IndexExpr': {
        const obj = yield* this.evalExpr(e.obj, scope);
        const key = yield* this.evalExpr(e.key, scope);
        try {
          return yield* index(obj, key);
        } catch (err) {
          throw this._decorate(err, 'index', this._describeExpr(e.obj, scope), obj);
        }
      }
      case 'CallExpr':
      case 'MethodCallExpr':
        return (yield* this.evalCall(e, scope))[0];
      case 'FuncExpr': {
        const f = new LuaClosure(e, scope, e.name, this);
        f.chunkname = this.chunkname;
        f.env = this.currentEnv(); // inherit the creating function's environment
        return f;
      }
      case 'TableExpr': {
        const t = new LuaTable();
        let n = 1;
        for (let i = 0; i < e.fields.length; i++) {
          const field = e.fields[i];
          if (field.type === 'rec') {
            const k = yield* this.evalExpr(field.key, scope);
            const v = yield* this.evalExpr(field.value, scope);
            t.set(k, v);
          } else if (i === e.fields.length - 1 &&
              (field.value.type === 'CallExpr' || field.value.type === 'MethodCallExpr' ||
               field.value.type === 'VarargExpr')) {
            const vals = yield* this.evalMulti([field.value], scope);
            for (const v of vals) {
              if (v !== undefined) t.set(n, v);
              n++;
            }
          } else {
            const v = yield* this.evalExpr(field.value, scope);
            if (v !== undefined) t.set(n, v);
            n++;
          }
        }
        return t;
      }
      case 'BinopExpr': {
        const op = e.op;
        if (op === 'and') {
          const a = yield* this.evalExpr(e.lhs, scope);
          if (!truthy(a)) return a;
          return yield* this.evalExpr(e.rhs, scope);
        }
        if (op === 'or') {
          const a = yield* this.evalExpr(e.lhs, scope);
          if (truthy(a)) return a;
          return yield* this.evalExpr(e.rhs, scope);
        }
        const a = yield* this.evalExpr(e.lhs, scope);
        const b = yield* this.evalExpr(e.rhs, scope);
        switch (op) {
          case '+': case '-': case '*': case '/': case '%': case '^':
            try {
              return yield* arith(ARITH_OP[op], a, b);
            } catch (err) {
              const aBad = luaToNumber(a) === undefined;
              const bad = aBad ? { x: e.lhs, v: a } : { x: e.rhs, v: b };
              throw this._decorate(err, 'perform arithmetic on',
                this._describeExpr(bad.x, scope), bad.v);
            }
          case '..':
            try {
              return yield* concat(a, b);
            } catch (err) {
              const aOk = typeof a === 'string' || typeof a === 'number';
              const bad = aOk ? { x: e.rhs, v: b } : { x: e.lhs, v: a };
              throw this._decorate(err, 'concatenate',
                this._describeExpr(bad.x, scope), bad.v);
            }
          case '==':
            return yield* compare('eq', a, b);
          case '~=':
            return !(yield* compare('eq', a, b));
          case '<':
            return yield* compare('lt', a, b);
          case '<=':
            return yield* compare('le', a, b);
          case '>':
            return yield* compare('lt', b, a);
          case '>=':
            return yield* compare('le', b, a);
          default:
            throw new LuaError(`unhandled binop ${op}`);
        }
      }
      case 'UnopExpr': {
        const v = yield* this.evalExpr(e.expr, scope);
        switch (e.op) {
          case '-':
            try {
              return yield* arith('unm', v, v);
            } catch (err) {
              throw this._decorate(err, 'perform arithmetic on',
                this._describeExpr(e.expr, scope), v);
            }
          case 'not': return !truthy(v);
          case '#':
            try {
              return yield* len(v);
            } catch (err) {
              throw this._decorate(err, 'get length of',
                this._describeExpr(e.expr, scope), v);
            }
        }
        break;
      }
      default:
        throw new LuaError(`unhandled expression type ${e.type}`);
    }
  }
}
