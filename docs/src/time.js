// Calendar helpers in the room's time zone (default Asia/Taipei).
import { serverNow } from './clock.js';

let TZ = 'Asia/Taipei';
export const setTz = (tz) => { if (tz) TZ = tz; };

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WD_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const fmts = new Map();
function fmt(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmts.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in tz. */
export function parts(ms, tz = TZ) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WD.indexOf(o.weekday) };
}
function offsetAt(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** Instant for a wall-clock time in tz (day overflow allowed, e.g. d + 3). */
export function zoned(y, mo, d, h, mi, tz = TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}
/** 23:59 of (today + n days) in the room's zone, by server time. */
export function endOfDay(n = 0, now = serverNow()) {
  const p = parts(now);
  return zoned(p.y, p.mo, p.d + n, 23, 59);
}
const dayNo = (ms) => { const p = parts(ms); return Date.UTC(p.y, p.mo - 1, p.d) / 864e5; };
export const dayDiff = (from, to) => dayNo(to) - dayNo(from);
export const dayKey = (ms) => { const p = parts(ms); return `${p.y}-${p.mo}-${p.d}`; };
const pad = (n) => String(n).padStart(2, '0');
export const fmtHM = (ms) => { const p = parts(ms); return `${pad(p.h)}:${pad(p.mi)}`; };
export const fmtMD = (ms) => { const p = parts(ms); return `${p.mo}/${p.d}`; };

/** "今天 23:59" / "明天 23:59" / "週五 23:59" / "10/12 23:59" */
export function fmtWhen(ms, now = serverNow()) {
  const dd = dayDiff(now, ms);
  const hm = fmtHM(ms);
  if (dd === 0) return `今天 ${hm}`;
  if (dd === 1) return `明天 ${hm}`;
  if (dd === -1) return `昨天 ${hm}`;
  if (dd > 1 && dd < 7) return `週${WD_ZH[parts(ms).wd]} ${hm}`;
  return `${fmtMD(ms)} ${hm}`;
}
export function fmtDayHeader(ms, now = serverNow()) {
  const dd = dayDiff(now, ms);
  if (dd === 0) return '今天';
  if (dd === -1) return '昨天';
  return `${fmtMD(ms)} 週${WD_ZH[parts(ms).wd]}`;
}
/** Due label for an active task: { text, urgent }. Urgent when < 1 h is left. */
export function dueLabel(dueMs, now = serverNow()) {
  const left = dueMs - now;
  if (left <= 0) return { text: '已逾期', urgent: true };
  if (left < 36e5) return { text: `${Math.max(1, Math.ceil(left / 6e4))} 分鐘`, urgent: true };
  if (left < 6 * 36e5) return { text: `剩 ${Math.floor(left / 36e5)} 小時 · ${fmtHM(dueMs)}`, urgent: false };
  return { text: fmtWhen(dueMs, now), urgent: false };
}
/** "m:ss" */
export const fmtMMSS = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };

/** <input type=datetime-local> value ⇄ instant, read as wall time in the room's zone. */
export function toLocalInput(ms) {
  const p = parts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
export function fromLocalInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  return m ? zoned(+m[1], +m[2], +m[3], +m[4], +m[5]) : NaN;
}
/** Monday 00:00 of the week containing `now` (used by the mock server). */
export function weekStart(now) {
  const p = parts(now);
  return zoned(p.y, p.mo, p.d - (p.wd + 6) % 7, 0, 0);
}
