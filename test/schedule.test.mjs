import test from 'node:test';
import assert from 'node:assert/strict';
import { singaporeDate, nextClockDate, clockTimestamp, describeShutdown } from '../public/schedule.js';
test('clock time uses Singapore regardless of host timezone and handles midnight rollover', () => {
  const now = Date.parse('2026-10-12T23:30:00+08:00');
  assert.equal(singaporeDate(now), '2026-10-12');
  assert.equal(nextClockDate('07:00', now), '2026-10-13');
  assert.equal(nextClockDate('23:45', now), '2026-10-12');
  assert.equal(nextClockDate('23:30', now), '2026-10-13');
  assert.equal(clockTimestamp('2026-10-13', '07:00'), Date.parse('2026-10-12T23:00:00Z'));
  assert.match(describeShutdown(clockTimestamp('2026-10-13', '07:00'), now), /^Tomorrow, .*Singapore time$/);
  assert.match(describeShutdown(clockTimestamp('2026-10-12', '23:45'), now), /^Today, /);
  for (const [date, time] of [['2026-02-30', '07:00'], ['2026-10-12', '24:00'], ['2026-10-12', '25:99'], ['invalid', '07:00'], ['2026-10-12', '']]) assert.ok(Number.isNaN(clockTimestamp(date, time)));
});
test('usage summary charges each session at switch-off and ignores top-ups and logging gaps', async () => {
  const { summarize, toCsv } = await import('../public/usage.js');
  const minute = 60000, start = Date.parse('2026-10-14T02:00:00+08:00');
  const rows = [{ t: start - minute, p: 0, r: 27, s: 22, b: 5 }];
  // 60 min on at $1.20/h charged on switch-off, 30 min off, a top-up, then an open Saver session.
  for (let i = 0; i <= 60; i++) rows.push({ t: start + i * minute, p: 1, r: 25, s: 22, b: 5 });
  rows.push({ t: start + 61 * minute, p: 0, r: 25, s: 22, b: 3.8, e: 'manual-off' });
  rows.push({ t: start + 90 * minute, p: 0, r: 27, s: 22, b: 13.8 });
  for (let i = 0; i <= 20; i++) rows.push({ t: start + (300 + i) * minute, p: i < 15 ? 1 : 0, r: 25, s: 22, b: i < 15 ? 13.8 : 13.5, m: 'i' });
  const summary = summarize(rows.slice(0, -6), start + 314 * minute);
  assert.equal(summary.sessions.length, 1);
  assert.ok(Math.abs(summary.sessions[0].cost - 1.2) < 1e-9); assert.equal(summary.sessions[0].ms, 61 * minute);
  assert.ok(Math.abs(summary.hourly - 1.2 / (61 / 60)) < 1e-9);
  assert.equal(summary.toppedUp, 10); assert.equal(summary.open.saver, true);
  assert.ok(Math.abs(summary.spentToday - 1.2) < 1e-9);
  const closed = summarize(rows, start + 320 * minute);
  assert.equal(closed.sessions.length, 2); assert.ok(Math.abs(closed.sessions[1].cost - 0.3) < 1e-9);
  assert.equal(Math.round(closed.saver.duty * 100), 75);
  assert.equal(toCsv(rows.slice(0, 1)).split('\n').length, 2);
});
test('daily totals price time on at the hourly rate and count Saver rest time as saved', async () => {
  const { daily, total, dailyCsv } = await import('../public/usage.js');
  const minute = 60000, start = Date.parse('2026-10-13T22:00:00+08:00'), rows = [];
  // Three hours of Saver, 10 min on then 5 min rest, charged at each switch-off.
  let balance = 10;
  for (let i = 0; i <= 180; i++) {
    const on = i < 180 && i % 15 < 10;
    if (i && i % 15 === 10) balance = Math.round((balance - 10 / 60 * 0.4) * 100) / 100;
    rows.push({ t: start + i * minute, p: on ? 1 : 0, r: 24, s: 22, b: balance, ...(i < 180 ? { m: 'i' } : {}) });
  }
  const days = daily(rows, start + 180 * minute, 3);
  assert.deepEqual(days.map(day => day.date), ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(days[1].onMs, 80 * minute); assert.equal(days[1].restMs, 40 * minute);
  assert.equal(days[2].onMs, 40 * minute); assert.equal(days[2].restMs, 20 * minute);
  const sum = total(days);
  assert.ok(Math.abs(sum.cost - 0.8) < 1e-9); assert.ok(Math.abs(sum.saved - 0.4) < 1e-9);
  assert.ok(Math.abs(sum.charged - 0.84) < 1e-9); assert.equal(sum.starts, 11); assert.equal(days[1].room, 24);
  assert.equal(dailyCsv(days).split('\n').length, 4);
});
test('stored day totals fill any date range and long ranges bucket into weeks and months', async () => {
  const { span, bucket, total, emptyDay } = await import('../public/usage.js');
  const stored = [{ ...emptyDay('2026-05-16'), onMs: 3600000, restMs: 1800000, charged: 0.4 }, { ...emptyDay('2026-05-19'), onMs: 7200000 }];
  const days = span(stored, '2026-05-15', '2026-05-20');
  assert.deepEqual(days.map(day => day.date), ['2026-05-15', '2026-05-16', '2026-05-17', '2026-05-18', '2026-05-19', '2026-05-20']);
  const sum = total(days);
  assert.ok(Math.abs(sum.cost - 1.2) < 1e-9); assert.ok(Math.abs(sum.saved - 0.2) < 1e-9); assert.equal(sum.charged, 0.4);
  assert.equal(bucket(days).size, 'day');
  const quarter = bucket(span(stored, '2026-04-01', '2026-06-30'));
  assert.equal(quarter.size, 'week'); assert.equal(quarter.bars.length, 13);
  assert.ok(Math.abs(quarter.bars.reduce((cost, bar) => cost + bar.cost, 0) - 1.2) < 1e-9);
  const years = bucket(span(stored, '2025-01-01', '2026-06-30'));
  assert.equal(years.size, 'month'); assert.equal(years.bars.length, 18);
});
