// lexer.js — tokenizer: Lua 5.1 (+goto) source text -> Token[] per SPEC.md "Token format"
import { LuaError, parseNumberBody } from './runtime.js';

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while',
]);

function isDigit(c) { return c >= '0' && c <= '9'; }
function isHexDigit(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
function isAlpha(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
}

export function tokenize(source, chunkname) {
  const tokens = [];
  const len = source.length;
  let pos = 0;
  let line = 1;

  function lexError(msg, errLine) {
    const e = new LuaError(`${chunkname}:${errLine === undefined ? line : errLine}: ${msg}`);
    e.positioned = true;
    throw e;
  }

  // Consume one newline at `pos` ('\n', '\r', '\r\n' or '\n\r' count as one); bumps line.
  function skipNewline() {
    const c = source[pos];
    pos++;
    const d = source[pos];
    if ((d === '\n' || d === '\r') && d !== c) pos++;
    line++;
  }

  // At '[': try to read a long-bracket opener '[' '='* '['. Returns the level
  // (number of '='), or -1 if this is not a long bracket (pos unchanged).
  function tryLongBracket() {
    let p = pos + 1;
    let level = 0;
    while (source[p] === '=') { level++; p++; }
    if (source[p] === '[') {
      pos = p + 1;
      return level;
    }
    return -1;
  }

  // Read the body of a long string/comment after the opening bracket of `level`.
  // Returns the raw contents (first newline skipped).
  function readLongBody(level, what) {
    const startLine = line;
    if (source[pos] === '\n' || source[pos] === '\r') skipNewline();
    const parts = [];
    let chunkStart = pos;
    for (;;) {
      if (pos >= len) {
        lexError(`unfinished long ${what} near '<eof>'`, startLine);
      }
      const c = source[pos];
      if (c === ']') {
        let p = pos + 1;
        let lv = 0;
        while (source[p] === '=') { lv++; p++; }
        if (lv === level && source[p] === ']') {
          parts.push(source.slice(chunkStart, pos));
          pos = p + 1;
          return parts.join('');
        }
        pos++;
      } else if (c === '\n' || c === '\r') {
        parts.push(source.slice(chunkStart, pos));
        skipNewline();
        parts.push('\n');
        chunkStart = pos;
      } else {
        pos++;
      }
    }
  }

  function readShortString(quote) {
    const startLine = line;
    pos++; // skip opening quote
    const parts = [];
    let chunkStart = pos;
    for (;;) {
      if (pos >= len) {
        lexError(`unfinished string near '<eof>'`, startLine);
      }
      const c = source[pos];
      if (c === quote) {
        parts.push(source.slice(chunkStart, pos));
        pos++;
        return parts.join('');
      }
      if (c === '\n' || c === '\r') {
        lexError(`unfinished string near '${parts.join('') + source.slice(chunkStart, pos)}'`, startLine);
      }
      if (c !== '\\') {
        pos++;
        continue;
      }
      // escape sequence
      parts.push(source.slice(chunkStart, pos));
      pos++; // skip backslash
      if (pos >= len) {
        lexError(`unfinished string near '<eof>'`, startLine);
      }
      const e = source[pos];
      switch (e) {
        case 'a': parts.push('\x07'); pos++; break;
        case 'b': parts.push('\b'); pos++; break;
        case 'f': parts.push('\f'); pos++; break;
        case 'n': parts.push('\n'); pos++; break;
        case 'r': parts.push('\r'); pos++; break;
        case 't': parts.push('\t'); pos++; break;
        case 'v': parts.push('\v'); pos++; break;
        case '\\': parts.push('\\'); pos++; break;
        case '"': parts.push('"'); pos++; break;
        case "'": parts.push("'"); pos++; break;
        case '\n': case '\r':
          skipNewline();
          parts.push('\n');
          break;
        case 'x': {
          pos++;
          let hex = '';
          for (let i = 0; i < 2; i++) {
            const h = source[pos];
            if (h === undefined || !isHexDigit(h)) {
              lexError(`hexadecimal digit expected near '\\x${hex}'`);
            }
            hex += h;
            pos++;
          }
          parts.push(String.fromCharCode(parseInt(hex, 16)));
          break;
        }
        case 'z': {
          pos++;
          while (pos < len && isSpace(source[pos])) {
            if (source[pos] === '\n' || source[pos] === '\r') skipNewline();
            else pos++;
          }
          break;
        }
        default: {
          if (isDigit(e)) {
            let num = 0;
            let i = 0;
            while (i < 3 && pos < len && isDigit(source[pos])) {
              num = num * 10 + (source.charCodeAt(pos) - 48);
              pos++;
              i++;
            }
            if (num > 255) {
              lexError(`decimal escape too large near '\\${num}'`);
            }
            parts.push(String.fromCharCode(num));
          } else {
            lexError(`invalid escape sequence near '\\${e}'`);
          }
          break;
        }
      }
      chunkStart = pos;
    }
  }

  function readNumber() {
    const start = pos;
    const isHex = source[pos] === '0' && (source[pos + 1] === 'x' || source[pos + 1] === 'X');
    while (pos < len) {
      const c = source[pos];
      if (isAlnum(c) || c === '.') {
        pos++;
        continue;
      }
      if (c === '+' || c === '-') {
        const prev = source[pos - 1];
        if ((isHex && (prev === 'p' || prev === 'P')) ||
            (!isHex && (prev === 'e' || prev === 'E'))) {
          pos++;
          continue;
        }
      }
      break;
    }
    const text = source.slice(start, pos);
    const value = parseNumberBody(text);
    if (value === undefined) {
      lexError(`malformed number near '${text}'`);
    }
    return value;
  }

  for (;;) {
    // skip whitespace and comments
    let scanning = true;
    while (scanning && pos < len) {
      const c = source[pos];
      if (c === '\n' || c === '\r') {
        skipNewline();
      } else if (c === ' ' || c === '\t' || c === '\v' || c === '\f') {
        pos++;
      } else if (c === '-' && source[pos + 1] === '-') {
        pos += 2;
        if (source[pos] === '[') {
          const level = tryLongBracket();
          if (level >= 0) {
            readLongBody(level, 'comment');
            continue;
          }
        }
        // line comment
        while (pos < len && source[pos] !== '\n' && source[pos] !== '\r') pos++;
      } else {
        scanning = false;
      }
    }

    if (pos >= len) {
      tokens.push({ type: 'eof', value: '<eof>', line });
      return tokens;
    }

    const tokLine = line;
    const c = source[pos];

    if (isAlpha(c)) {
      const start = pos;
      while (pos < len && isAlnum(source[pos])) pos++;
      const word = source.slice(start, pos);
      tokens.push({
        type: KEYWORDS.has(word) ? 'keyword' : 'name',
        value: word,
        line: tokLine,
      });
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(source[pos + 1]))) {
      const value = readNumber();
      tokens.push({ type: 'number', value, line: tokLine });
      continue;
    }

    if (c === '"' || c === "'") {
      const value = readShortString(c);
      tokens.push({ type: 'string', value, line: tokLine });
      continue;
    }

    if (c === '[') {
      const level = tryLongBracket();
      if (level >= 0) {
        const value = readLongBody(level, 'string');
        tokens.push({ type: 'string', value, line: tokLine });
        continue;
      }
      if (source[pos + 1] === '=') {
        lexError(`invalid long string delimiter near '${source.slice(pos, pos + 2)}'`);
      }
      tokens.push({ type: 'op', value: '[', line: tokLine });
      pos++;
      continue;
    }

    // operators, longest match first
    const three = source.slice(pos, pos + 3);
    if (three === '...') {
      tokens.push({ type: 'op', value: '...', line: tokLine });
      pos += 3;
      continue;
    }
    const two = source.slice(pos, pos + 2);
    if (two === '..' || two === '==' || two === '~=' || two === '<=' ||
        two === '>=' || two === '::') {
      tokens.push({ type: 'op', value: two, line: tokLine });
      pos += 2;
      continue;
    }
    if ('.<>=(){}];:,+-*/%^#'.indexOf(c) >= 0) {
      tokens.push({ type: 'op', value: c, line: tokLine });
      pos++;
      continue;
    }

    lexError(`unexpected symbol near '${c}'`);
  }
}
