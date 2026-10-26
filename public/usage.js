// Usage maths and chart for logged readings. Rows: t time, p power, r room °C, s target, b balance, m saver, e event.
import { singaporeDate } from './schedule.js';

const GAP = 10 * 60000; // Longer silences are treated as missing data, not as cooling time.

// Daikin settles the charge when the aircon switches off, so cost is attributed to whole on→off sessions.
export function summarize(rows, now = Date.now()) {
  const today = singaporeDate(now);
  const sessions = [];
  const saver = { onMs: 0, totalMs: 0, tempSum: 0, tempCount: 0 };
  let open = null, last = null, spentToday = 0, onTodayMs = 0, toppedUp = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], prev = rows[i - 1];
    if (prev) {
      const span = Math.min(row.t - prev.t, GAP);
      const drop = prev.b != null && row.b != null ? prev.b - row.b : 0;
      if (drop < 0) toppedUp -= drop;
      if (prev.p) {
        if (open) open.ms += span;
        if (singaporeDate(row.t) === today) onTodayMs += span;
      }
      if (prev.m) { saver.totalMs += span; if (prev.p) saver.onMs += span; }
      if (drop > 0) {
        // A charge that lands just after switch-off belongs to the session that just ended.
        const target = open ?? (last && row.t - last.end < GAP ? last : null);
        if (target) target.cost += drop; else sessions.push({ start: prev.t, end: row.t, ms: 0, cost: drop, saver: false, unlogged: true });
        if (singaporeDate(row.t) === today) spentToday += drop;
      }
    }
    if (row.m && row.r != null) { saver.tempSum += row.r; saver.tempCount++; }
    // A session already running when logging began (or resumed) has an unknown length, so it cannot inform the rate.
    if (row.p && !open) open = { start: row.t, end: null, ms: 0, cost: 0, saver: Boolean(row.m), partial: !prev || row.t - prev.t > GAP };
    if (!row.p && open) { open.end = row.t; sessions.push(open); last = open; open = null; }
  }
  const billed = sessions.filter(s => !s.unlogged && !s.partial && s.ms >= 60000);
  const billedMs = billed.reduce((sum, s) => sum + s.ms, 0);
  const billedCost = billed.reduce((sum, s) => sum + s.cost, 0);
  const hourly = billedMs >= 5 * 60000 && billedCost > 0 ? billedCost / (billedMs / 3600000) : null;
  const balance = rows.findLast(row => row.b != null)?.b ?? null;
  return {
    balance, hourly, spentToday, onTodayMs, toppedUp, sessions, open,
    pending: open && hourly ? hourly * open.ms / 3600000 : null,
    hoursLeft: hourly && balance != null ? balance / hourly : null,
    saver: saver.totalMs >= 10 * 60000 ? { duty: saver.onMs / saver.totalMs, room: saver.tempCount ? saver.tempSum / saver.tempCount : null, ms: saver.totalMs } : null,
  };
}

// Hall rate confirmed by the owner; finished sessions measured about the same.
export const RATE = 0.40;
const DAY = 86400000;

// Per-day totals are built one pair of consecutive readings at a time, so the server can keep them forever
// without re-reading raw rows. Time goes to the earlier reading's day; a charge or switch-on to the later one's.
export const emptyDay = date => ({ date, onMs: 0, restMs: 0, loggedMs: 0, charged: 0, starts: 0, roomSum: 0, roomMs: 0 });
export function tally(dayFor, prev, row) {
  const day = dayFor(singaporeDate(prev.t));
  if (day && row.t - prev.t <= GAP) {
    const span = row.t - prev.t;
    day.loggedMs += span;
    if (prev.p) day.onMs += span; else if (prev.m) day.restMs += span;
    if ((prev.p || prev.m) && prev.r != null) { day.roomSum += prev.r * span; day.roomMs += span; }
  }
  const settled = dayFor(singaporeDate(row.t));
  if (settled && prev.b != null && row.b != null && prev.b > row.b) settled.charged = Math.round((settled.charged + prev.b - row.b) * 100) / 100;
  if (settled && row.p && !prev.p) settled.starts++;
}
// Cost is time switched on × rate, so it splits cleanly at midnight and includes a session not yet charged.
// Saved is Saver rest time: minutes that running nonstop would have billed.
export const priced = (day, rate = RATE) => ({ ...day, cost: day.onMs / 3600000 * rate, saved: day.restMs / 3600000 * rate, room: day.roomMs ? day.roomSum / day.roomMs : null });
const addDays = (date, count) => singaporeDate(Date.parse(`${date}T12:00:00+08:00`) + count * DAY);
// Every date from first to last (inclusive), filled from stored day totals; days with no readings are zero.
export function span(stored, first, last) {
  const known = new Map(stored.map(day => [day.date, day]));
  const days = [];
  for (let date = first; date <= last && days.length < 4000; date = addDays(date, 1)) days.push(priced(known.get(date) ?? emptyDay(date)));
  return days;
}
// One entry per Singapore day from raw readings, oldest first.
export function daily(rows, now = Date.now(), days = 30) {
  const byDate = new Map();
  for (let i = days - 1; i >= 0; i--) byDate.set(singaporeDate(now - i * DAY), emptyDay(singaporeDate(now - i * DAY)));
  for (let i = 1; i < rows.length; i++) tally(date => byDate.get(date), rows[i - 1], rows[i]);
  return [...byDate.values()].map(day => priced(day));
}
// Long ranges are drawn as weeks or months so bars stay readable.
export function bucket(days) {
  const size = days.length > 400 ? 'month' : days.length > 45 ? 'week' : 'day';
  if (size === 'day') return { size, bars: days.map(day => ({ ...day, label: dateLabel(day.date), tick: day.date })) };
  const bars = [];
  days.forEach((day, i) => {
    const key = size === 'month' ? day.date.slice(0, 7) : Math.floor(i / 7);
    let bar = bars.at(-1);
    if (!bar || bar.key !== key) { bar = { key, date: day.date, tick: day.date, last: day.date, onMs: 0, restMs: 0, cost: 0, saved: 0, charged: 0, starts: 0 }; bars.push(bar); }
    for (const field of ['onMs', 'restMs', 'cost', 'saved', 'charged', 'starts']) bar[field] += day[field];
    bar.last = day.date;
  });
  for (const bar of bars) bar.label = size === 'month' ? monthLabel.format(Date.parse(`${bar.date}T12:00:00+08:00`)) : `${dateLabel(bar.date)} – ${dateLabel(bar.last)}`;
  return { size, bars };
}
export function total(days) {
  const sum = { onMs: 0, restMs: 0, cost: 0, saved: 0, charged: 0, starts: 0 };
  for (const day of days) for (const key of Object.keys(sum)) sum[key] += day[key];
  return sum;
}
const dayLabel = new Intl.DateTimeFormat([], { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short' });
const monthShort = new Intl.DateTimeFormat([], { timeZone: 'Asia/Singapore', month: 'short', year: '2-digit' });
const monthLabel = new Intl.DateTimeFormat([], { timeZone: 'Asia/Singapore', month: 'long', year: 'numeric' });
const monthDay = new Intl.DateTimeFormat([], { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short' });
export const dateLabel = date => dayLabel.format(Date.parse(`${date}T12:00:00+08:00`));

export const money = value => value == null ? '--' : `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
export function duration(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
const clock = new Intl.DateTimeFormat([], { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' });
const dayClock = new Intl.DateTimeFormat([], { timeZone: 'Asia/Singapore', weekday: 'short', hour: 'numeric', minute: '2-digit' });
export const clockTime = (stamp, long) => (long ? dayClock : clock).format(stamp);

const NS = 'http://www.w3.org/2000/svg';
function el(name, attributes = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

// One temperature axis. Cooling is a shaded band behind the line, never a second scale.
export function drawChart(svg, tooltip, rows, from, to) {
  const width = Math.max(280, svg.clientWidth || 640), height = 220;
  const pad = { left: 34, right: 12, top: 12, bottom: 26 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const temps = rows.flatMap(row => [row.r, row.s]).filter(value => value != null);
  const low = Math.floor(Math.min(...temps, 24)) - 1, high = Math.ceil(Math.max(...temps, 27)) + 1;
  const x = t => pad.left + (t - from) / (to - from) * (width - pad.left - pad.right);
  const y = v => pad.top + (high - v) / (high - low) * (height - pad.top - pad.bottom);
  const long = to - from > 36 * 3600000;
  // Cooling bands first so grid and line sit above them.
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].p) continue;
    const end = Math.min(rows[i + 1]?.t ?? to, rows[i].t + GAP);
    svg.append(el('rect', { class: 'chart-band', x: x(rows[i].t), y: pad.top, width: Math.max(.5, x(end) - x(rows[i].t)), height: height - pad.top - pad.bottom }));
  }
  const step = high - low > 8 ? 2 : 1;
  for (let v = low + 1; v < high; v += step) {
    svg.append(el('line', { class: 'chart-grid', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    svg.append(el('text', { class: 'chart-tick', x: pad.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${v}°`));
  }
  const ticks = Math.max(2, Math.min(6, Math.floor(width / 110)));
  for (let i = 0; i <= ticks; i++) {
    const t = from + (to - from) * i / ticks;
    svg.append(el('text', { class: 'chart-tick', x: x(t), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }, clockTime(t, long)));
  }
  // Readings are whole degrees, so draw steps; break the line across logging gaps.
  const path = key => {
    let d = '', prev = null;
    for (const row of rows) {
      if (row[key] == null) { prev = null; continue; }
      d += prev && row.t - prev.t <= GAP ? `H${x(row.t).toFixed(1)}V${y(row[key]).toFixed(1)}` : `M${x(row.t).toFixed(1)},${y(row[key]).toFixed(1)}`;
      prev = row;
    }
    return d;
  };
  svg.append(el('path', { class: 'chart-target', d: path('s') }), el('path', { class: 'chart-room', d: path('r') }));
  const cross = el('line', { class: 'chart-cross', y1: pad.top, y2: height - pad.bottom, visibility: 'hidden' });
  const dot = el('circle', { class: 'chart-dot', r: 4, visibility: 'hidden' });
  svg.append(cross, dot);
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip.hidden = true; };
  svg.onpointerleave = hide;
  svg.onpointermove = event => {
    const box = svg.getBoundingClientRect();
    const t = from + (event.clientX - box.left - pad.left * box.width / width) / ((width - pad.left - pad.right) * box.width / width) * (to - from);
    let row = null;
    for (const candidate of rows) if (!row || Math.abs(candidate.t - t) < Math.abs(row.t - t)) row = candidate;
    if (!row || Math.abs(row.t - t) > GAP) { hide(); return; }
    cross.setAttribute('x1', x(row.t)); cross.setAttribute('x2', x(row.t)); cross.setAttribute('visibility', 'visible');
    if (row.r != null) { dot.setAttribute('cx', x(row.t)); dot.setAttribute('cy', y(row.r)); dot.setAttribute('visibility', 'visible'); }
    tooltip.replaceChildren();
    for (const [label, value] of [[clockTime(row.t, true), row.p ? 'Cooling' : 'Off'], ['Room', row.r == null ? '--' : `${row.r}°C`], ['Target', row.s == null ? '--' : `${row.s}°C`], ['Balance', money(row.b)]]) {
      const line = document.createElement('div'), name = document.createElement('span'), strong = document.createElement('strong');
      name.textContent = label; strong.textContent = value; line.append(name, strong); tooltip.append(line);
    }
    tooltip.hidden = false;
    const left = x(row.t) * box.width / width;
    tooltip.style.left = `${Math.max(0, Math.min(box.width - tooltip.offsetWidth, left + (left > box.width / 2 ? -tooltip.offsetWidth - 12 : 12)))}px`;
  };
}

export function toCsv(rows) {
  return ['time_iso,epoch_ms,power,room_c,target_c,balance,saver,event',
    ...rows.map(row => [new Date(row.t).toISOString(), row.t, row.p, row.r ?? '', row.s ?? '', row.b ?? '', row.m ?? '', row.e ?? ''].join(','))].join('\n');
}

// Stacked daily bars on one dollar axis: spent at the base, Saver's saving on top, so the full bar is what nonstop would have cost.
export function drawCost(svg, tooltip, days) {
  const { size, bars: shown } = bucket(days);
  const width = Math.max(280, svg.clientWidth || 640), height = 200;
  const pad = { left: 40, right: 8, top: 12, bottom: 24 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const peak = Math.max(...shown.map(day => day.cost + day.saved), 0.5);
  const unit = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].find(candidate => peak / candidate <= 4) ?? 200;
  const top = Math.ceil(peak / unit) * unit;
  const slot = (width - pad.left - pad.right) / shown.length;
  const bar = Math.max(2, Math.min(24, slot - (slot > 8 ? 4 : 1)));
  const base = height - pad.bottom;
  const y = v => base - v / top * (base - pad.top);
  for (let v = 0; v <= top + 1e-9; v += unit) {
    svg.append(el('line', { class: v ? 'chart-grid' : 'chart-axis', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    svg.append(el('text', { class: 'chart-tick', x: pad.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, `$${v.toFixed(unit < 1 ? 2 : 0)}`));
  }
  // Rounded top, square base. A 2px gap separates the two segments.
  const segment = (x, from, to, name) => {
    const h = from - to; if (h < 0.5) return null;
    const r = Math.min(4, bar / 2, h);
    return el('path', { class: name, d: `M${x},${from}V${to + r}Q${x},${to} ${x + r},${to}H${x + bar - r}Q${x + bar},${to} ${x + bar},${to + r}V${from}Z` });
  };
  const every = Math.ceil(shown.length / Math.max(2, Math.floor(width / 70)));
  shown.forEach((day, i) => {
    const x = pad.left + slot * i + (slot - bar) / 2;
    const spentTop = y(day.cost);
    const marks = [segment(x, base, spentTop, 'bar-spent'), segment(x, spentTop - (day.cost ? 2 : 0), y(day.cost + day.saved) - (day.cost ? 2 : 0), 'bar-saved')].filter(Boolean);
    // Name the month on the first label and whenever it changes.
    if ((shown.length - 1 - i) % every === 0) {
      const named = size !== 'day' || i < every || Number(day.date.slice(8)) <= every;
      const stamp = Date.parse(`${day.tick}T12:00:00+08:00`);
      svg.append(el('text', { class: 'chart-tick', x: x + bar / 2, y: height - 6, 'text-anchor': 'middle' }, size === 'month' ? monthShort.format(stamp) : named ? monthDay.format(stamp) : String(Number(day.date.slice(8)))));
    }
    const hit = el('rect', { class: 'bar-hit', x: pad.left + slot * i, y: pad.top, width: slot, height: base - pad.top, tabindex: 0, 'aria-label': `${day.label}: spent ${money(day.cost)}, saved ${money(day.saved)}` });
    const show = () => {
      tooltip.replaceChildren();
      for (const [label, value] of [[day.label, ''], ['Spent', money(day.cost)], ['Saved by Saver', money(day.saved)], ['Nonstop would cost', money(day.cost + day.saved)], ['Switched on', duration(day.onMs)], ['Resting', duration(day.restMs)]]) {
        const line = document.createElement('div'), name = document.createElement('span'), strong = document.createElement('strong');
        name.textContent = label; strong.textContent = value; line.append(name, strong); tooltip.append(line);
      }
      tooltip.hidden = false;
      const box = svg.getBoundingClientRect(), left = (x + bar / 2) * box.width / width;
      tooltip.style.left = `${Math.max(0, Math.min(box.width - tooltip.offsetWidth, left + (left > box.width / 2 ? -tooltip.offsetWidth - 12 : 12)))}px`;
    };
    for (const type of ['pointerenter', 'focus']) hit.addEventListener(type, show);
    for (const type of ['pointerleave', 'blur']) hit.addEventListener(type, () => { tooltip.hidden = true; });
    svg.append(...marks, hit);
  });
}

export function dailyCsv(days) {
  return ['date,hours_on,hours_resting,cost_at_rate,saved_at_rate,charged_by_daikin,switch_ons,avg_room_c,hours_logged',
    ...days.map(day => [day.date, (day.onMs / 3600000).toFixed(3), (day.restMs / 3600000).toFixed(3), day.cost.toFixed(3), day.saved.toFixed(3), day.charged.toFixed(2), day.starts, day.room?.toFixed(1) ?? '', (day.loggedMs / 3600000).toFixed(2)].join(','))].join('\n');
}
