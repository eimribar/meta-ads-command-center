// Days and schedule times in one time zone: TIMEZONE, or the ad account's own time zone when
// TIMEZONE is not set (Meta reports each day in the account's time zone), or UTC.
import { rt } from './runtime.mjs';

let zone = 'UTC';
export function setTimezone(tz) {
  if (!tz) return zone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zone = tz; } catch { throw new Error(`TIMEZONE is not a known time zone name (for example America/New_York)`); }
  return zone;
}
export const timezone = () => zone;

function parts(date, tz = zone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, weekday: p.weekday.toLowerCase() };
}

// 'YYYY-MM-DD' for a moment, in the zone.
export function dayOf(date = rt.now(), tz = zone) {
  const p = parts(date, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
export const today = () => dayOf(rt.now());
export function daysAgo(k, from = rt.now()) {
  const [y, m, d] = dayOf(from).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - k));
  return t.toISOString().slice(0, 10);
}
export const range = (days, { endOffset = 0 } = {}) => ({ since: daysAgo(days - 1 + endOffset), until: daysAgo(endOffset) });
export function weekdayOf(date = rt.now(), tz = zone) { return parts(date, tz).weekday; }

// The UTC moment of a wall clock time in a zone (handles daylight saving).
export function zonedTime(y, mo, d, h, mi, tz = zone) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), tz);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, mo - 1, d, h, mi) - seen;
  }
  return new Date(guess);
}

// The next time a daily job at {h, m} runs, strictly after `now`.
export function nextDaily({ h, m }, now = rt.now(), tz = zone) {
  const p = parts(now, tz);
  for (let add = 0; add < 3; add++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + add));
    const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m, tz);
    if (at > now) return at;
  }
  throw new Error('could not compute the next run');
}

// The next time a weekly job on `weekday` at {h, m} runs.
export function nextWeekly(weekday, { h, m }, now = rt.now(), tz = zone) {
  let at = nextDaily({ h, m }, now, tz);
  for (let i = 0; i < 8 && weekdayOf(at, tz) !== weekday; i++) at = nextDaily({ h, m }, at, tz);
  return at;
}

// Today's slot time for a daily job, or null if it is still ahead.
export function passedToday({ h, m }, now = rt.now(), tz = zone) {
  const p = parts(now, tz);
  const at = zonedTime(p.y, p.mo, p.d, h, m, tz);
  return at <= now ? at : null;
}
