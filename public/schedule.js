export const ZONE = 'Asia/Singapore';
const DAY = 86400000;
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export function singaporeDate(stamp) {
  const parts = Object.fromEntries(dateFormat.formatToParts(stamp).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function clockTimestamp(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return NaN;
  const stamp = Date.parse(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(stamp) || singaporeDate(stamp) !== date || new Date(stamp + 8 * 3600000).toISOString().slice(11,16) !== time) return NaN;
  return stamp;
}
export function nextClockDate(time, now = Date.now()) {
  const today = singaporeDate(now);
  return clockTimestamp(today, time) > now ? today : singaporeDate(now + DAY);
}
export function shutdownDay(stamp, now = Date.now()) {
  const date = singaporeDate(stamp);
  return date === singaporeDate(now) ? 'Today' : date === singaporeDate(now + DAY) ? 'Tomorrow' : new Intl.DateTimeFormat(undefined, { timeZone: ZONE, month: 'short', day: 'numeric', year: 'numeric' }).format(stamp);
}
export function describeShutdown(stamp, now = Date.now()) {
  const label = shutdownDay(stamp, now);
  const clock = new Intl.DateTimeFormat(undefined, { timeZone: ZONE, hour: 'numeric', minute: '2-digit' }).format(stamp);
  return `${label}, ${clock} · Singapore time`;
}
