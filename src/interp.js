// interp.js — generator-based tree-walking evaluator. See docs/SPEC.md
// "src/interp.js — exact exports" and "Evaluator architecture".
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import {
  LuaError, LuaTable, LuaClosure,
  setClosureCall, setCurrentInterp, runToCompletion,
  callValue, index, newindex, arith, compare, concat, len,
  truthy, luaToNumber, typeName,
} from './runtime.js';

class Scope {
  constructor(parent) {
    this.vars = new Map();
    this.parent = parent;
    // function-boundary scopes additionally get a `varargs` own property
    // (array for vararg functions, null otherwise).
  }
}

function lookup(scope, name) {
  for (let s = scope; s !== null; s = s.parent) {
    const cell = s.vars.get(name);
    if (cell !== undefined) return cell;
  }
  return null;
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
  for (;;) {
    const proto = closure.proto;
    const scope = new Scope(closure.scope);
    for (let i = 0; i < proto.params.length; i++) {
      scope.vars.set(proto.params[i], { v: args[i] });
    }
    scope.varargs = proto.isVararg ? args.slice(proto.params.length) : null;
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
        args = c.args;
        continue;
      }
      return yield* callValue(c.f, c.args);
    }
    // goto with no matching label anywhere in the function body
    throw new LuaError(`no visible label '${c.label}' for goto`);
  }
}

export class Interp {
  constructor(opts = {}) {
    this.stdout = opts.stdout ?? ((s) => process.stdout.write(s));
    this.stderr = opts.stderr ?? ((s) => process.stderr.write(s));
    this.chunkname = opts.chunkname ?? 'v8lua';
    this.globals = new LuaTable();
    this.globals.set('_G', this.globals);
    this.currentLine = 0;
    this.coStack = []; // running coroutines, innermost last
    setCurrentInterp(this);
    setClosureCall(closureCall);
  }

  compile(source, chunkname = this.chunkname) {
    const ast = parse(tokenize(source, chunkname), chunkname);
    const proto = {
      type: 'FuncExpr', params: [], isVararg: true,
      body: ast.body, name: chunkname, line: 0,
    };
    const closure = new LuaClosure(proto, null, chunkname, this);
    closure.chunkname = chunkname;
    return closure;
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
        e.luaMessage = `${this.chunkname}:${line}: ${e.luaMessage}`;
      }
      e.positioned = true;
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
    this.currentLine = stmt.line;
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
        cell.v = f;
        return;
      }
      case 'AssignStat': {
        const vals = yield* this.evalMulti(stmt.exprs, scope);
        for (let i = 0; i < stmt.targets.length; i++) {
          const t = stmt.targets[i];
          const v = vals[i];
          if (t.type === 'NameExpr') {
            const cell = lookup(scope, t.name);
            if (cell !== null) cell.v = v;
            else yield* newindex(this.globals, t.name, v);
          } else {
            const obj = yield* this.evalExpr(t.obj, scope);
            const key = yield* this.evalExpr(t.key, scope);
            try {
              yield* newindex(obj, key, v);
            } catch (err) {
              throw this._decorate(err, 'index', this._describeExpr(t.obj, scope), obj);
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
        for (;;) {
          const rets = yield* callValue(f, [s, control]);
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
        return yield* index(this.globals, e.name);
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
