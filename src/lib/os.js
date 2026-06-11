// os.js — Lua os library (subset).
import { LuaError, LuaTable, NativeFunction, luaToNumber, typeName } from '../runtime.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function yday(d, utc) {
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  const start = utc ? Date.UTC(year, 0, 1) : new Date(year, 0, 1).getTime();
  const today = utc
    ? Date.UTC(year, d.getUTCMonth(), d.getUTCDate())
    : new Date(year, d.getMonth(), d.getDate()).getTime();
  return Math.round((today - start) / 86400000) + 1;
}

function strftime(fmt, d, utc) {
  const get = {
    Y: () => utc ? d.getUTCFullYear() : d.getFullYear(),
    m: () => (utc ? d.getUTCMonth() : d.getMonth()) + 1,
    d: () => utc ? d.getUTCDate() : d.getDate(),
    H: () => utc ? d.getUTCHours() : d.getHours(),
    M: () => utc ? d.getUTCMinutes() : d.getMinutes(),
    S: () => utc ? d.getUTCSeconds() : d.getSeconds(),
    w: () => utc ? d.getUTCDay() : d.getDay(),
  };
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] !== '%') {
      out += fmt[i++];
      continue;
    }
    i++;
    const c = fmt[i++];
    switch (c) {
      case 'Y': out += get.Y(); break;
      case 'y': out += pad2(get.Y() % 100); break;
      case 'm': out += pad2(get.m()); break;
      case 'd': out += pad2(get.d()); break;
      case 'H': out += pad2(get.H()); break;
      case 'I': out += pad2(((get.H() + 11) % 12) + 1); break;
      case 'M': out += pad2(get.M()); break;
      case 'S': out += pad2(get.S()); break;
      case 'p': out += get.H() < 12 ? 'AM' : 'PM'; break;
      case 'A': out += DAY_NAMES[get.w()]; break;
      case 'a': out += DAY_NAMES[get.w()].slice(0, 3); break;
      case 'B': out += MONTH_NAMES[get.m() - 1]; break;
      case 'b': out += MONTH_NAMES[get.m() - 1].slice(0, 3); break;
      case 'j': out += pad3(yday(d, utc)); break;
      case 'w': out += get.w(); break;
      case 'x': out += `${pad2(get.m())}/${pad2(get.d())}/${pad2(get.Y() % 100)}`; break;
      case 'X': out += `${pad2(get.H())}:${pad2(get.M())}:${pad2(get.S())}`; break;
      case 'c':
        out += `${DAY_NAMES[get.w()].slice(0, 3)} ${MONTH_NAMES[get.m() - 1].slice(0, 3)} ` +
          `${String(get.d()).padStart(2, ' ')} ${pad2(get.H())}:${pad2(get.M())}:${pad2(get.S())} ${get.Y()}`;
        break;
      case '%': out += '%'; break;
      default: out += '%' + c; break;
    }
  }
  return out;
}

export default function install(I) {
  const lib = new LuaTable();
  const native = (name, fn) => lib.set(name, new NativeFunction(name, fn));
  const t0 = process.hrtime.bigint();

  native('clock', function* (I, args) {
    return [Number(process.hrtime.bigint() - t0) / 1e9];
  });

  native('time', function* (I, args) {
    const t = args[0];
    if (t === undefined) return [Math.floor(Date.now() / 1000)];
    if (!(t instanceof LuaTable)) {
      throw new LuaError(`bad argument #1 to 'time' (table expected, got ${typeName(t)})`);
    }
    const field = (name, def) => {
      const v = luaToNumber(t.get(name));
      if (v === undefined) {
        if (def === undefined) throw new LuaError(`field '${name}' missing in date table`);
        return def;
      }
      return v;
    };
    const d = new Date(field('year'), field('month') - 1, field('day'),
      field('hour', 12), field('min', 0), field('sec', 0));
    return [Math.floor(d.getTime() / 1000)];
  });

  native('date', function* (I, args) {
    let fmt = args[0] === undefined ? '%c' : args[0];
    if (typeof fmt !== 'string') {
      throw new LuaError(`bad argument #1 to 'date' (string expected, got ${typeName(fmt)})`);
    }
    const tArg = args[1] === undefined ? Date.now() / 1000 : luaToNumber(args[1]);
    const d = new Date(tArg * 1000);
    let utc = false;
    if (fmt[0] === '!') {
      utc = true;
      fmt = fmt.slice(1);
    }
    if (fmt.startsWith('*t')) {
      const out = new LuaTable();
      out.set('year', utc ? d.getUTCFullYear() : d.getFullYear());
      out.set('month', (utc ? d.getUTCMonth() : d.getMonth()) + 1);
      out.set('day', utc ? d.getUTCDate() : d.getDate());
      out.set('hour', utc ? d.getUTCHours() : d.getHours());
      out.set('min', utc ? d.getUTCMinutes() : d.getMinutes());
      out.set('sec', utc ? d.getUTCSeconds() : d.getSeconds());
      out.set('wday', (utc ? d.getUTCDay() : d.getDay()) + 1);
      out.set('yday', yday(d, utc));
      out.set('isdst', false);
      return [out];
    }
    return [strftime(fmt, d, utc)];
  });

  native('difftime', function* (I, args) {
    return [luaToNumber(args[0]) - (args[1] === undefined ? 0 : luaToNumber(args[1]))];
  });

  native('getenv', function* (I, args) {
    const v = process.env[args[0]];
    return [v === undefined ? undefined : v];
  });

  native('exit', function* (I, args) {
    const c = args[0];
    process.exit(c === undefined || c === true ? 0 : c === false ? 1 : c);
  });

  I.globals.set('os', lib);
}
