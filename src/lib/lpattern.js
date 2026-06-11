// lpattern.js — Lua 5.1 pattern matcher (port of lstrlib.c match logic).
// Pure string/number code; no Lua plumbing. Indices are 0-based JS indices,
// end-exclusive. Position captures are reported as 1-based numbers.
import { LuaError } from '../runtime.js';

export const MAXCAPTURES = 32;

const CAP_UNFINISHED = -1;
const CAP_POSITION = -2;

function isDigitC(c) { return c >= 48 && c <= 57; }
function isAlphaC(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isLowerC(c) { return c >= 97 && c <= 122; }
function isUpperC(c) { return c >= 65 && c <= 90; }
function isAlnumC(c) { return isDigitC(c) || isAlphaC(c); }
function isSpaceC(c) { return c === 32 || (c >= 9 && c <= 13); }
function isCntrlC(c) { return c < 32 || c === 127; }
function isXdigitC(c) {
  return isDigitC(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}
function isPunctC(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
         (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

function matchClass(c, cl) {
  let res;
  switch (cl | 32) { // tolower
    case 97: res = isAlphaC(c); break;          // a
    case 99: res = isCntrlC(c); break;          // c
    case 100: res = isDigitC(c); break;         // d
    case 108: res = isLowerC(c); break;         // l
    case 112: res = isPunctC(c); break;         // p
    case 115: res = isSpaceC(c); break;         // s
    case 117: res = isUpperC(c); break;         // u
    case 119: res = isAlnumC(c); break;         // w
    case 120: res = isXdigitC(c); break;        // x
    default: return cl === c;
  }
  if (cl >= 65 && cl <= 90) res = !res; // uppercase class letter complements
  return res;
}

export function patternError(msg) {
  return new LuaError(msg);
}

class MatchState {
  constructor(src, pat) {
    this.src = src;
    this.pat = pat;
    this.level = 0;
    this.capture = []; // {init, len}
  }
}

function classEnd(ms, p) {
  const pat = ms.pat;
  const c = pat.charCodeAt(p++);
  if (c === 37) { // '%'
    if (p >= pat.length) throw patternError("malformed pattern (ends with '%')");
    return p + 1;
  }
  if (c === 91) { // '['
    if (pat.charCodeAt(p) === 94) p++; // '^'
    do {
      if (p >= pat.length) throw patternError("malformed pattern (missing ']')");
      const cc = pat.charCodeAt(p++);
      if (cc === 37) { // '%'
        if (p >= pat.length) throw patternError("malformed pattern (ends with '%')");
        p++;
      }
    } while (pat.charCodeAt(p) !== 93); // ']'
    return p + 1;
  }
  return p;
}

function matchBracketClass(ms, c, p, ec) {
  const pat = ms.pat;
  let sig = true;
  if (pat.charCodeAt(p + 1) === 94) { // '^'
    sig = false;
    p++;
  }
  while (++p < ec) {
    const pc = pat.charCodeAt(p);
    if (pc === 37) { // '%'
      p++;
      if (matchClass(c, pat.charCodeAt(p))) return sig;
    } else if (pat.charCodeAt(p + 1) === 45 && p + 2 < ec) { // '-' range
      if (pc <= c && c <= pat.charCodeAt(p + 2)) return sig;
      p += 2;
    } else if (pc === c) {
      return sig;
    }
  }
  return !sig;
}

function singleMatch(ms, s, p, ep) {
  if (s >= ms.src.length) return false;
  const c = ms.src.charCodeAt(s);
  const pc = ms.pat.charCodeAt(p);
  switch (pc) {
    case 46: return true; // '.'
    case 37: return matchClass(c, ms.pat.charCodeAt(p + 1)); // '%'
    case 91: return matchBracketClass(ms, c, p, ep - 1); // '['
    default: return pc === c;
  }
}

function matchBalance(ms, s, p) {
  if (p + 1 >= ms.pat.length) {
    throw patternError("unbalanced pattern");
  }
  if (ms.src.charCodeAt(s) !== ms.pat.charCodeAt(p)) return -1;
  const b = ms.pat.charCodeAt(p);
  const e = ms.pat.charCodeAt(p + 1);
  let cont = 1;
  let i = s + 1;
  while (i < ms.src.length) {
    const c = ms.src.charCodeAt(i);
    if (c === e) {
      if (--cont === 0) return i + 1;
    } else if (c === b) {
      cont++;
    }
    i++;
  }
  return -1;
}

function maxExpand(ms, s, p, ep) {
  let i = 0;
  while (singleMatch(ms, s + i, p, ep)) i++;
  while (i >= 0) {
    const res = doMatch(ms, s + i, ep + 1);
    if (res !== -1) return res;
    i--;
  }
  return -1;
}

function minExpand(ms, s, p, ep) {
  for (;;) {
    const res = doMatch(ms, s, ep + 1);
    if (res !== -1) return res;
    if (singleMatch(ms, s, p, ep)) s++;
    else return -1;
  }
}

function startCapture(ms, s, p, what) {
  if (ms.level >= MAXCAPTURES) throw patternError('too many captures');
  ms.capture[ms.level] = { init: s, len: what };
  ms.level++;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.level--;
  return res;
}

function captureToClose(ms) {
  for (let l = ms.level - 1; l >= 0; l--) {
    if (ms.capture[l].len === CAP_UNFINISHED) return l;
  }
  throw patternError('invalid pattern capture');
}

function endCapture(ms, s, p) {
  const l = captureToClose(ms);
  ms.capture[l].len = s - ms.capture[l].init;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.capture[l].len = CAP_UNFINISHED;
  return res;
}

function matchCapture(ms, s, ch) {
  const l = ch - 49; // '1' -> 0
  if (l < 0 || l >= ms.level || ms.capture[l].len === CAP_UNFINISHED) {
    throw patternError(`invalid capture index %${l + 1}`);
  }
  const cap = ms.src.slice(ms.capture[l].init, ms.capture[l].init + ms.capture[l].len);
  if (ms.src.startsWith(cap, s)) return s + cap.length;
  return -1;
}

function doMatch(ms, s, p) {
  for (;;) {
    if (p >= ms.pat.length) return s;
    const pc = ms.pat.charCodeAt(p);
    switch (pc) {
      case 40: // '('
        if (ms.pat.charCodeAt(p + 1) === 41) { // '()' position capture
          return startCapture(ms, s, p + 2, CAP_POSITION);
        }
        return startCapture(ms, s, p + 1, CAP_UNFINISHED);
      case 41: // ')'
        return endCapture(ms, s, p + 1);
      case 36: // '$'
        if (p + 1 === ms.pat.length) {
          return s === ms.src.length ? s : -1;
        }
        break; // else: literal '$', fall through to default handling
      case 37: { // '%'
        const nc = ms.pat.charCodeAt(p + 1);
        if (nc === 98) { // 'b'
          const res = matchBalance(ms, s, p + 2);
          if (res === -1) return -1;
          s = res;
          p += 4;
          continue;
        }
        if (nc === 102) { // 'f' frontier
          p += 2;
          if (ms.pat.charCodeAt(p) !== 91) { // '['
            throw patternError("missing '[' after '%f' in pattern");
          }
          const ep = classEnd(ms, p);
          const prev = s === 0 ? 0 : ms.src.charCodeAt(s - 1);
          const cur = s < ms.src.length ? ms.src.charCodeAt(s) : 0;
          if (!matchBracketClass(ms, prev, p, ep - 1) &&
              matchBracketClass(ms, cur, p, ep - 1)) {
            p = ep;
            continue;
          }
          return -1;
        }
        if (nc >= 48 && nc <= 57) { // %0-%9 backref
          const res = matchCapture(ms, s, nc);
          if (res === -1) return -1;
          s = res;
          p += 2;
          continue;
        }
        break;
      }
    }
    // default: single char class possibly followed by a quantifier
    const ep = classEnd(ms, p);
    const m = singleMatch(ms, s, p, ep);
    const suffix = ep < ms.pat.length ? ms.pat.charCodeAt(ep) : 0;
    switch (suffix) {
      case 63: { // '?'
        if (m) {
          const res = doMatch(ms, s + 1, ep + 1);
          if (res !== -1) return res;
        }
        p = ep + 1;
        continue;
      }
      case 42: // '*'
        return maxExpand(ms, s, p, ep);
      case 43: // '+'
        return m ? maxExpand(ms, s + 1, p, ep) : -1;
      case 45: // '-'
        return minExpand(ms, s, p, ep);
      default:
        if (!m) return -1;
        s++;
        p = ep;
        continue;
    }
  }
}

function captureValues(ms, s, e, wholeIfNone) {
  const n = ms.level;
  if (n === 0 && wholeIfNone) return [ms.src.slice(s, e)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const cap = ms.capture[i];
    if (cap.len === CAP_POSITION) out.push(cap.init + 1);
    else if (cap.len === CAP_UNFINISHED) throw patternError('unfinished capture');
    else out.push(ms.src.slice(cap.init, cap.init + cap.len));
  }
  return out;
}

// Find the first match of `pat` in `s` starting at 0-based index `init`.
// Handles a leading '^' anchor. Returns
// { start, end, captures } (0-based, end-exclusive; captures NEVER includes
// the whole match — empty array when the pattern has no captures) or null.
export function match(s, pat, init = 0) {
  let p = 0;
  let anchor = false;
  if (pat.charCodeAt(0) === 94) { // '^'
    anchor = true;
    p = 1;
  }
  let s1 = init;
  const ms = new MatchState(s, pat);
  do {
    ms.level = 0;
    ms.capture.length = 0;
    const e = doMatch(ms, s1, p);
    if (e !== -1) {
      return { start: s1, end: e, captures: captureValues(ms, s1, e, false) };
    }
    s1++;
  } while (s1 <= s.length && !anchor);
  return null;
}

// Capture list for a successful match, substituting the whole match when the
// pattern has no captures (string.match / gmatch / gsub semantics).
export function capturesOf(s, m) {
  return m.captures.length > 0 ? m.captures : [s.slice(m.start, m.end)];
}
