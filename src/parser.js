// parser.js — tokens -> AST per docs/SPEC.md "AST specification".
import { LuaError } from './runtime.js';

// Binary operator priorities: [left, right]. Right-assoc ops have right < left.
const BINOP_PRI = {
  'or': [1, 1], 'and': [2, 2],
  '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
  '..': [5, 4],
  '+': [6, 6], '-': [6, 6],
  '*': [7, 7], '/': [7, 7], '%': [7, 7],
  '^': [10, 9],
};
const UNARY_PRI = 8;

const BLOCK_FOLLOW = new Set(['end', 'else', 'elseif', 'until', '<eof>']);

export function parse(tokens, chunkname) {
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function tokenText(t) {
    if (t.type === 'eof') return '<eof>';
    if (t.type === 'string') return 'string';
    if (t.type === 'number') return String(t.value);
    return String(t.value);
  }

  function syntaxError(msg, tok) {
    tok = tok || peek();
    const e = new LuaError(`${chunkname}:${tok.line}: ${msg} near '${tokenText(tok)}'`);
    e.positioned = true;
    throw e;
  }

  function isToken(t, value) {
    return (t.type === 'keyword' || t.type === 'op') && t.value === value;
  }
  function check(value) { return isToken(peek(), value); }
  function accept(value) {
    if (check(value)) { next(); return true; }
    return false;
  }
  function expect(value, what) {
    if (!check(value)) syntaxError(`'${value}' expected${what ? ' ' + what : ''}`);
    return next();
  }
  function expectName() {
    const t = peek();
    if (t.type !== 'name') syntaxError('<name> expected');
    next();
    return t.value;
  }

  // Per-function context for vararg / label checking.
  function newFuncCtx(isVararg) {
    return { isVararg, labels: new Set(), gotos: [] };
  }
  let funcCtx = newFuncCtx(true); // chunk is a vararg function
  let loopDepth = 0;

  function checkGotos(ctx) {
    for (const g of ctx.gotos) {
      if (!ctx.labels.has(g.label)) {
        const e = new LuaError(`${chunkname}:${g.line}: no visible label '${g.label}' for goto`);
        e.positioned = true;
        throw e;
      }
    }
  }

  // ---------- expressions ----------

  function parseExpr(limit = 0) {
    let e;
    const t = peek();
    if (isToken(t, 'not') || isToken(t, '-') || isToken(t, '#')) {
      next();
      const operand = parseExpr(UNARY_PRI);
      e = { type: 'UnopExpr', op: t.value, expr: operand, line: t.line };
    } else {
      e = parseSimpleExpr();
    }
    for (;;) {
      const op = peek();
      const pri = (op.type === 'op' || op.type === 'keyword') ? BINOP_PRI[op.value] : undefined;
      if (pri === undefined || pri[0] <= limit) break;
      next();
      const rhs = parseExpr(pri[1]);
      e = { type: 'BinopExpr', op: op.value, lhs: e, rhs, line: op.line };
    }
    return e;
  }

  function parseSimpleExpr() {
    const t = peek();
    switch (t.type) {
      case 'number': next(); return { type: 'NumberExpr', value: t.value, line: t.line };
      case 'string': next(); return { type: 'StringExpr', value: t.value, line: t.line };
      case 'keyword':
        if (t.value === 'nil') { next(); return { type: 'NilExpr', line: t.line }; }
        if (t.value === 'true') { next(); return { type: 'TrueExpr', line: t.line }; }
        if (t.value === 'false') { next(); return { type: 'FalseExpr', line: t.line }; }
        if (t.value === 'function') { next(); return parseFuncBody(null, false, t.line); }
        break;
      case 'op':
        if (t.value === '...') {
          if (!funcCtx.isVararg) syntaxError("cannot use '...' outside a vararg function");
          next();
          return { type: 'VarargExpr', line: t.line };
        }
        if (t.value === '{') return parseTableExpr();
        break;
    }
    return parseSuffixedExpr();
  }

  function parsePrimaryExpr() {
    const t = peek();
    if (t.type === 'name') {
      next();
      return { type: 'NameExpr', name: t.value, line: t.line };
    }
    if (isToken(t, '(')) {
      next();
      const inner = parseExpr();
      expect(')');
      return { type: 'ParenExpr', expr: inner, line: t.line };
    }
    syntaxError('unexpected symbol');
  }

  function parseCallArgs() {
    const t = peek();
    if (t.type === 'string') {
      next();
      return [{ type: 'StringExpr', value: t.value, line: t.line }];
    }
    if (isToken(t, '{')) {
      return [parseTableExpr()];
    }
    expect('(');
    const args = [];
    if (!check(')')) {
      do { args.push(parseExpr()); } while (accept(','));
    }
    expect(')');
    return args;
  }

  function parseSuffixedExpr() {
    let e = parsePrimaryExpr();
    for (;;) {
      const t = peek();
      if (isToken(t, '.')) {
        next();
        const name = expectName();
        e = { type: 'IndexExpr', obj: e, key: { type: 'StringExpr', value: name, line: t.line }, line: t.line };
      } else if (isToken(t, '[')) {
        next();
        const key = parseExpr();
        expect(']');
        e = { type: 'IndexExpr', obj: e, key, line: t.line };
      } else if (isToken(t, ':')) {
        next();
        const method = expectName();
        const args = parseCallArgs();
        e = { type: 'MethodCallExpr', obj: e, method, args, line: t.line };
      } else if (isToken(t, '(') || isToken(t, '{') || t.type === 'string') {
        const args = parseCallArgs();
        e = { type: 'CallExpr', func: e, args, line: t.line };
      } else {
        return e;
      }
    }
  }

  function parseTableExpr() {
    const open = expect('{');
    const fields = [];
    while (!check('}')) {
      if (check('[')) {
        next();
        const key = parseExpr();
        expect(']');
        expect('=');
        fields.push({ type: 'rec', key, value: parseExpr() });
      } else if (peek().type === 'name' && isToken(tokens[pos + 1], '=')) {
        const nameTok = next();
        next(); // '='
        fields.push({
          type: 'rec',
          key: { type: 'StringExpr', value: nameTok.value, line: nameTok.line },
          value: parseExpr(),
        });
      } else {
        fields.push({ type: 'item', value: parseExpr() });
      }
      if (!accept(',') && !accept(';')) break;
    }
    expect('}');
    return { type: 'TableExpr', fields, line: open.line };
  }

  // body: after 'function' [name already consumed]; isMethod prepends 'self'.
  function parseFuncBody(name, isMethod, line) {
    expect('(');
    const params = isMethod ? ['self'] : [];
    let isVararg = false;
    if (!check(')')) {
      do {
        if (check('...')) { next(); isVararg = true; break; }
        params.push(expectName());
      } while (accept(','));
    }
    expect(')');
    const outerCtx = funcCtx;
    const outerLoopDepth = loopDepth;
    funcCtx = newFuncCtx(isVararg);
    loopDepth = 0;
    const body = parseBlock();
    checkGotos(funcCtx);
    funcCtx = outerCtx;
    loopDepth = outerLoopDepth;
    expect('end', `(to close 'function' at line ${line})`);
    return { type: 'FuncExpr', params, isVararg, body, name, line };
  }

  // ---------- statements ----------

  function parseBlock() {
    const startTok = peek();
    const stmts = [];
    for (;;) {
      const t = peek();
      if (t.type === 'eof' || (t.type === 'keyword' && BLOCK_FOLLOW.has(t.value))) break;
      if (isToken(t, 'return')) {
        stmts.push(parseReturn());
        break;
      }
      const s = parseStatement();
      if (s !== null) stmts.push(s);
    }
    return { type: 'Block', stmts, line: startTok.line };
  }

  function parseReturn() {
    const t = expect('return');
    const exprs = [];
    if (!accept(';')) {
      const f = peek();
      const atEnd = f.type === 'eof' || (f.type === 'keyword' && BLOCK_FOLLOW.has(f.value));
      if (!atEnd) {
        do { exprs.push(parseExpr()); } while (accept(','));
        accept(';');
      }
    }
    return { type: 'ReturnStat', exprs, line: t.line };
  }

  function parseStatement() {
    const t = peek();
    if (isToken(t, ';')) { next(); return null; }
    if (isToken(t, '::')) {
      next();
      const name = expectName();
      expect('::');
      funcCtx.labels.add(name);
      return { type: 'LabelStat', name, line: t.line };
    }
    if (t.type === 'keyword') {
      switch (t.value) {
        case 'break':
          next();
          if (loopDepth === 0) syntaxError("no loop to break", t);
          return { type: 'BreakStat', line: t.line };
        case 'goto': {
          next();
          const label = expectName();
          funcCtx.gotos.push({ label, line: t.line });
          return { type: 'GotoStat', label, line: t.line };
        }
        case 'do': {
          next();
          const body = parseBlock();
          expect('end', `(to close 'do' at line ${t.line})`);
          return { type: 'DoStat', body, line: t.line };
        }
        case 'while': {
          next();
          const cond = parseExpr();
          expect('do');
          loopDepth++;
          const body = parseBlock();
          loopDepth--;
          expect('end', `(to close 'while' at line ${t.line})`);
          return { type: 'WhileStat', cond, body, line: t.line };
        }
        case 'repeat': {
          next();
          loopDepth++;
          const body = parseBlock();
          loopDepth--;
          expect('until', `(to close 'repeat' at line ${t.line})`);
          const cond = parseExpr();
          return { type: 'RepeatStat', body, cond, line: t.line };
        }
        case 'if': {
          next();
          const clauses = [];
          const cond = parseExpr();
          expect('then');
          clauses.push({ cond, body: parseBlock() });
          let elseBody = null;
          for (;;) {
            if (accept('elseif')) {
              const c = parseExpr();
              expect('then');
              clauses.push({ cond: c, body: parseBlock() });
            } else if (accept('else')) {
              elseBody = parseBlock();
              break;
            } else {
              break;
            }
          }
          expect('end', `(to close 'if' at line ${t.line})`);
          return { type: 'IfStat', clauses, elseBody, line: t.line };
        }
        case 'for':
          return parseFor();
        case 'function':
          return parseFunctionStat();
        case 'local':
          return parseLocal();
      }
    }
    return parseExprStatement();
  }

  function parseFor() {
    const t = expect('for');
    const firstName = expectName();
    if (check('=')) {
      next();
      const start = parseExpr();
      expect(',');
      const limit = parseExpr();
      let step = null;
      if (accept(',')) step = parseExpr();
      expect('do');
      loopDepth++;
      const body = parseBlock();
      loopDepth--;
      expect('end', `(to close 'for' at line ${t.line})`);
      return { type: 'NumForStat', name: firstName, start, limit, step, body, line: t.line };
    }
    const names = [firstName];
    while (accept(',')) names.push(expectName());
    expect('in');
    const exprs = [];
    do { exprs.push(parseExpr()); } while (accept(','));
    expect('do');
    loopDepth++;
    const body = parseBlock();
    loopDepth--;
    expect('end', `(to close 'for' at line ${t.line})`);
    return { type: 'GenForStat', names, exprs, body, line: t.line };
  }

  function parseFunctionStat() {
    const t = expect('function');
    // funcname: Name {'.' Name} [':' Name]
    const baseTok = peek();
    let target = { type: 'NameExpr', name: expectName(), line: baseTok.line };
    let fullName = baseTok.value;
    let isMethod = false;
    for (;;) {
      if (accept('.')) {
        const k = expectName();
        fullName += '.' + k;
        target = {
          type: 'IndexExpr', obj: target,
          key: { type: 'StringExpr', value: k, line: baseTok.line },
          line: baseTok.line,
        };
      } else if (accept(':')) {
        const k = expectName();
        fullName += ':' + k;
        target = {
          type: 'IndexExpr', obj: target,
          key: { type: 'StringExpr', value: k, line: baseTok.line },
          line: baseTok.line,
        };
        isMethod = true;
        break;
      } else {
        break;
      }
    }
    const func = parseFuncBody(fullName, isMethod, t.line);
    return { type: 'AssignStat', targets: [target], exprs: [func], line: t.line };
  }

  function parseLocal() {
    const t = expect('local');
    if (accept('function')) {
      const name = expectName();
      const func = parseFuncBody(name, false, t.line);
      return { type: 'LocalFuncStat', name, func, line: t.line };
    }
    const names = [expectName()];
    while (accept(',')) names.push(expectName());
    const exprs = [];
    if (accept('=')) {
      do { exprs.push(parseExpr()); } while (accept(','));
    }
    return { type: 'LocalStat', names, exprs, line: t.line };
  }

  function parseExprStatement() {
    const t = peek();
    const e = parseSuffixedExpr();
    if (check('=') || check(',')) {
      const targets = [e];
      while (accept(',')) targets.push(parseSuffixedExpr());
      expect('=');
      const exprs = [];
      do { exprs.push(parseExpr()); } while (accept(','));
      for (const target of targets) {
        if (target.type !== 'NameExpr' && target.type !== 'IndexExpr') {
          syntaxError('syntax error', t);
        }
      }
      return { type: 'AssignStat', targets, exprs, line: t.line };
    }
    if (e.type !== 'CallExpr' && e.type !== 'MethodCallExpr') {
      syntaxError('syntax error', t);
    }
    return { type: 'CallStat', expr: e, line: t.line };
  }

  // ---------- chunk ----------

  const body = parseBlock();
  checkGotos(funcCtx);
  if (peek().type !== 'eof') syntaxError("'<eof>' expected");
  return { type: 'Chunk', body, line: 1 };
}
