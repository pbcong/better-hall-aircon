import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createVault } from './vault.mjs';
import { singaporeDate } from './public/schedule.js';
import { tally, emptyDay } from './public/usage.js';

const UPSTREAM = 'https://apintu-prod.daikinpayu.com';
// Conservative demo bounds, not a claim about every NTU controller's limits.
const TEMPERATURE_LIMITS = { min: 22, max: 30 };
// Saver phases shorter than three minutes risk short-cycling the unit; these are demo guardrails.
const SAVER_LIMITS = { minMinutes: 3, maxMinutes: 120, minTemperature: 18, maxTemperature: 32 };
// Readings are logged every minute while cooling or saving, and every five minutes while idle.
const POLL_ACTIVE = 60000, POLL_IDLE = 300000;
// An unconfirmed turn-off is resent every 15 s, up to 8 times within 10 minutes.
const OFF_RETRY_MS = 15000, OFF_RETRIES = 8, OFF_GIVE_UP_MS = 600000;
// No balance drop this long after a switch-off means someone else paid for that session.
const SETTLE_MS = 600000;
// Saver is on unless the owner switches it off: Turn on then cools in cycles instead of running nonstop.
// The first cooling phase is longer to bring the room down; after that the short cycle holds it there.
const SAVER_DEFAULTS = { enabled: true, kind: 'interval', firstMinutes: 10, onMinutes: 5, offMinutes: 5, coolTo: 24, warmTo: 26 };
const phaseMs = v => (v.phase === 'off' ? v.offMinutes : v.switches === 0 ? v.firstMinutes ?? v.onMinutes : v.onMinutes) * 60000;
const ASSETS = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/schedule.js', ['public/schedule.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/usage.js', ['public/usage.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/apple-touch-icon.png', ['public/apple-touch-icon.png', 'image/png']],
]);
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const ROOM_ID = 'personal_room_'.padEnd(43, '_');
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function parseLoginReturn(value) {
  if (typeof value !== 'string' || !/^https?:/i.test(value.trim())) return null;
  let url;
  try { url = new URL(value.trim()); } catch { throw new AppError(400, 'Invalid Daikin return URL.'); }
  if (!url.pathname.startsWith('/adfs/saml/redirect/')) return null;
  if (url.origin !== 'https://cmsntu-prod.daikinpayu.com' || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'Use the final Daikin HTTPS return URL without extra parameters.');
  }
  let hash;
  try { hash = decodeURIComponent(url.pathname.slice('/adfs/saml/redirect/'.length)); }
  catch { throw new AppError(400, 'Invalid login code encoding.'); }
  return parseToken(hash);
}

// A pasted return URL is parsed locally, never fetched. Only the fixed /me endpoint validates it.
export function parseAirconCredential(value) {
  if (typeof value !== 'string') throw new AppError(400, 'Paste the final Daikin return URL or your aircon token.');
  const trimmed = value.trim();
  if (!/^https?:/i.test(trimmed)) return parseToken(trimmed);
  let url;
  try { url = new URL(trimmed); } catch { throw new AppError(400, 'Invalid return URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['cmsntu-prod.daikinpayu.com', 'apintu-prod.daikinpayu.com'].includes(url.hostname)) {
    throw new AppError(400, 'Paste only the final HTTPS Daikin return URL, not the NTU sign-in URL.');
  }
  const values = [];
  const fragment = new URLSearchParams(url.hash.slice(1));
  for (const params of [url.searchParams, fragment]) {
    for (const key of ['token', 'access_token', 'bearer_token']) values.push(...params.getAll(key));
  }
  if (values.length !== 1) throw new AppError(400, 'This Daikin URL does not contain a single recognized aircon token. Keep it private; share only the page message and parameter names to investigate.');
  return parseToken(values[0]);
}

// Raw tokens are still supported for advanced users. Passwords and SSO cookies are not accepted.
export function parseToken(value) {
  if (typeof value !== 'string') throw new AppError(400, 'Paste a Daikin aircon token.');
  const token = value.trim().replace(/^Bearer\s+/i, '');
  if (!/^[A-Za-z0-9._~+\/-]{20,8192}={0,2}$/.test(token)) {
    throw new AppError(400, 'Expected an aircon bearer token, not a password or login URL.');
  }
  return token;
}
const labelOrNull = value => typeof value === 'string' && /^[A-Za-z0-9]{1,4}$/.test(value) ? value : null;
// Rows: t time, p power, r room °C, s setpoint, b balance, m saver kind, e event that caused the reading.
export function memoryHistory(limit = 5000) {
  const rows = [], months = new Map();
  return { append: async row => { rows.push(row); if (rows.length > limit) rows.shift(); }, read: async since => rows.filter(row => row.t >= since),
    months: async () => [...months.keys()], month: async id => structuredClone(months.get(id)), putMonth: async (id, value) => { months.set(id, structuredClone(value)); } };
}
export function fileHistory(path) {
  // Day totals live beside the raw log in one small JSON file, keyed by month.
  const dailyPath = path.replace(/\.jsonl$/, '') + '-daily.json';
  let totals;
  const load = async () => {
    if (totals) return totals;
    try { totals = JSON.parse(await readFile(dailyPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; totals = {}; }
    return totals;
  };
  return {
    months: async () => Object.keys(await load()),
    month: async id => structuredClone((await load())[id]),
    async putMonth(id, value) { (await load())[id] = structuredClone(value); await writeFile(dailyPath, JSON.stringify(totals), { mode: 0o600 }); },
    append: row => appendFile(path, JSON.stringify(row) + '\n', { mode: 0o600 }),
    async read(since) {
      let text;
      try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      // A crash can leave one partial line; skip it rather than lose the log.
      return text.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row?.t >= since ? [row] : []; } catch { return []; } });
    },
  };
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function normalizeStatus(body) {
  const data = body?.data;
  if (!data || typeof data !== 'object' || !data.aircon || typeof data.aircon !== 'object') {
    throw new AppError(502, 'Daikin returned an unfamiliar status format. No command was sent.');
  }
  const ac = data.aircon;
  if (![0, 1, '0', '1', true, false].includes(ac.power)) {
    throw new AppError(502, 'Daikin did not return a usable power status.');
  }
  // While on, 'aircon.wallet' names the student being charged ('aircon.account' is only the room's default
  // holder). Only the comparison with this account leaves this function, never either ID.
  const mine = data.residence_id, payer = ac.wallet?.residence_id;
  // Deliberately omit name, matric number, room address and all credentials.
  return { power: Number(ac.power) === 1, payer: typeof mine === 'string' && mine && typeof payer === 'string' && payer ? (payer === mine ? 'you' : 'other') : null, temperature: numberOrNull(ac.current_temperature),
    setpoint: numberOrNull(ac.setpoint), balance: numberOrNull(data.balance), fan: labelOrNull(ac.fanstep), checkedAt: Date.now() };
}
export function createDaikinClient(fetchImpl = fetch, { cloud = false } = {}) {
  async function request(path, token, body) {
    let response;
    try {
      response = await fetchImpl(UPSTREAM + path, {
        method: body ? 'POST' : 'GET', redirect: cloud ? 'manual' : 'error', signal: AbortSignal.timeout(12000),
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json',
          'User-Agent': 'Dart/3.0 (dart:io)', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } : {}) },
        ...(body ? { body: new URLSearchParams(body) } : {}),
      });
    } catch (error) {
      if (!cloud) throw new AppError(502, 'Cannot reach Daikin. Check your internet connection and try again.');
      const step = path === '/auth/ad/callback' ? 'login exchange' : path === '/me' ? 'status check' : 'control request';
      const reason = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timed out' : 'connection failed';
      throw new AppError(502, `Cloudflare could not reach Daikin during ${step} (${reason}).`);
    }
    if (cloud && response.status >= 300 && response.status < 400) {
      throw new AppError(502, 'Daikin redirected the cloud request. No redirect was followed.');
    }
    // NTU's Daikin service currently uses HTTP 402 for an unauthenticated /me request.
    if ([401, 402, 403].includes(response.status)) throw new AppError(401, 'Your aircon token was rejected or expired. Reconnect using a fresh token.');
    if (!response.ok) throw new AppError(502, 'Daikin could not complete the request. Please try again.');
    // Never return upstream errors or bodies to the browser or logs.
    let value;
    try { value = await response.json(); } catch { throw new AppError(502, 'Daikin returned an unreadable response.'); }
    const metaStatus = numberOrNull(value?.meta?.status);
    if ([401, 402, 403].includes(metaStatus)) throw new AppError(401, 'Your aircon token was rejected or expired. Reconnect using a fresh token.');
    if (value?.success === false || value?.status === false || numberOrNull(value?.code) >= 400 || metaStatus >= 400) {
      throw new AppError(502, 'Daikin did not accept the request.');
    }
    return value;
  }
  return {
    exchange: async hash => {
      const result = await request('/auth/ad/callback', null, { hash });
      if (typeof result?.data?.token !== 'string') throw new AppError(502, 'Daikin did not return an aircon token. Sign in again.');
      return parseToken(result.data.token);
    },
    status: async token => normalizeStatus(await request('/me', token)),
    control: async (token, power) => { await request('/v2/ac/control', token, { power: power ? '1' : '0' }); },
    temperature: async (token, setpoint) => { await request('/v2/ac/control', token, { power: '1', setpoint: String(setpoint) }); },
  };
}

export function createApp({ client = createDaikinClient(), now = Date.now, sessionMs = 30 * 24 * 3600 * 1000,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), vault = null, initialRecords = [], hostedOrigin = null, sharedRoom = false, history = memoryHistory() } = {}) {
  const sessions = new Map();
  const rate = new Map();
  const loginTickets = new Map();
  for (const record of initialRecords.slice(0, 20)) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(record.id) || (!sharedRoom && record.expiresAt <= now()) || (!hostedOrigin && record.mode !== 'live')) continue;
    if (record.token) parseToken(record.token);
    sessions.set(sharedRoom ? ROOM_ID : record.id, { ...structuredClone(record), expiresAt: sharedRoom ? Number.MAX_SAFE_INTEGER : record.expiresAt, csrf: hostedOrigin ? (record.csrf ?? secret()) : secret(), busy: false, loginTicket: null, saver: record.saver ?? null, saverConfig: record.saverConfig ?? null, lastRow: record.lastRow ?? null, ledger: record.ledger ?? false, nextPoll: record.nextPoll ?? now() });
  }
  let committed = structuredClone([...sessions.entries()]);
  const persist = async () => {
    if (!vault) return;
    const records = [...sessions.entries()].filter(([, s]) => s.expiresAt > now() && (hostedOrigin || (s.mode === 'live' && s.remember))).map(([id, s]) => ({
      id, csrf: hostedOrigin ? s.csrf : undefined, token: s.token, mode: s.mode, remember: s.remember, status: s.status, timer: s.timer, saver: s.saver, saverConfig: s.saverConfig, lastRow: s.lastRow, ledger: s.ledger, nextPoll: s.nextPoll, offWanted: s.offWanted, session: s.session, ended: s.ended, onSentAt: s.onSentAt, lastResult: s.lastResult, expiresAt: s.expiresAt,
    }));
    try {
      await vault.save(records);
      committed = structuredClone([...sessions.entries()].map(([id, s]) => [id, { ...s, busy: false }]));
    } catch (error) {
      for (const [id, saved] of committed) {
        const current = sessions.get(id);
        if (current) Object.assign(current, structuredClone(saved)); else sessions.set(id, structuredClone(saved));
      }
      for (const id of sessions.keys()) if (!committed.some(([key]) => key === id)) sessions.delete(id);
      const stage = ['encryption', 'transaction', 'write', 'alarm'].includes(error.storageStage) ? error.storageStage : 'unknown';
      throw new AppError(503, hostedOrigin ? `Could not save your connection in cloud storage (${stage}). Please try again.` : 'Could not save the connection safely. Check local storage and try again.');
    }
  };
  function publicState(s) {
    return { connected: Boolean(s.mode), mode: s.mode, status: s.status, timer: s.timer, saver: s.saver ?? null, saverConfig: { ...SAVER_DEFAULTS, ...s.saverConfig }, saverLimits: SAVER_LIMITS,
      lastResult: s.lastResult, busy: s.busy, turningOff: Boolean(s.mode && s.offWanted && !s.offWanted.gaveUp),
      session: s.session ? { mine: s.session.mine, known: s.session.known, start: s.session.start } : null,
      lastSession: s.ended ? { result: s.ended.result, charged: s.ended.charged ?? null, start: s.ended.start, end: s.ended.end } : null, expiresAt: sharedRoom ? null : s.expiresAt, hosted: Boolean(hostedOrigin), authenticated: true, serverNow: now(), timezone: 'Asia/Singapore', remembered: Boolean(s.remember && vault), temperatureLimits: TEMPERATURE_LIMITS,
      loginWaiting: Boolean(s.loginTicket && loginTickets.has(s.loginTicket)), loginExpiresAt: loginTickets.get(s.loginTicket)?.expiresAt ?? null };
  }
  function forget(s) {
    if (s.loginTicket) loginTickets.delete(s.loginTicket);
    s.loginTicket = null; s.token = null; s.mode = null; s.timer = null; s.saver = null; s.status = null; s.lastResult = null; s.remember = false; delete s.offWanted; delete s.session; delete s.ended;
  }
  async function connect(s, credential, remember) {
    if (hostedOrigin && !remember) throw new AppError(400, 'Cloud timers require a remembered connection. Keep the checkbox selected.');
    const hash = parseLoginReturn(credential);
    const token = hash ? await client.exchange(hash) : parseAirconCredential(credential);
    const checked = await client.status(token);
    const timer = s.mode === 'practice' ? null : s.timer;
    const lastResult = s.mode === 'practice' ? null : s.lastResult;
    forget(s); s.timer = timer; s.lastResult = lastResult; s.token = token; s.mode = 'live'; s.status = checked; s.remember = remember;
    s.nextPoll = now() + POLL_ACTIVE; await record(s, 'connect');
  }
  async function status(s) {
    if (s.mode === 'practice') return { ...s.status, checkedAt: now() };
    return client.status(s.token);
  }
  // Only real equipment is logged; a logging failure must never block a command.
  async function record(s, event) {
    observe(s);
    if (s.mode !== 'live' || !s.status) return;
    const row = { t: now(), p: s.status.power ? 1 : 0, r: s.status.temperature, s: s.status.setpoint, b: s.status.balance ?? null,
      ...(s.saver?.state === 'running' ? { m: s.saver.kind[0] } : {}), ...(event ? { e: event } : {}) };
    try { await history.append(row); await ledger(s, row); } catch { /* Keep controlling the aircon. */ }
  }
  // Day totals are kept forever and updated from each new reading, so any date range can be summed cheaply.
  async function ledger(s, row) {
    const prev = s.lastRow; s.lastRow = row;
    const months = new Map();
    // First run: rebuild from the raw readings logged before day totals existed.
    const rows = s.ledger ? (prev ? [prev, row] : []) : await history.read(now() - 744 * 3600000);
    for (let i = 1; i < rows.length; i++) {
      for (const stamp of [rows[i - 1].t, rows[i].t]) {
        const id = singaporeDate(stamp).slice(0, 7);
        if (!months.has(id)) months.set(id, s.ledger ? await history.month(id) ?? {} : {});
      }
      tally(date => (months.get(date.slice(0, 7))[date] ??= emptyDay(date)), rows[i - 1], rows[i]);
    }
    for (const [id, value] of months) await history.putMonth(id, value);
    s.ledger = true;
  }
  // Whose wallet a session uses: Daikin's wallet field when present, otherwise whether this app switched it on.
  // After switch-off your balance confirms it, since a session you pay for is charged the moment it ends.
  function observe(s) {
    const st = s.status;
    if (!st) return;
    // An on this app sent can take a while to show, so it still counts as ours a few minutes later.
    const ours = s.onSentAt != null && now() - s.onSentAt < 180000;
    if (st.power) {
      s.session ??= { start: now(), mine: ours, known: false, balance: st.balance ?? null };
      if (st.payer) Object.assign(s.session, { mine: st.payer === 'you', known: true });
      return;
    }
    if (s.session) { s.ended = { ...s.session, end: now(), result: null }; delete s.session; }
    const e = s.ended;
    if (!e || e.result) return;
    if (e.balance != null && st.balance != null && st.balance < e.balance - 0.001) {
      e.result = 'you'; e.charged = Math.round((e.balance - st.balance) * 100) / 100;
    } else if (now() - e.end >= SETTLE_MS) e.result = e.end - e.start >= 120000 ? 'other' : 'unknown';
  }
  // A reason is kept only for stops the owner did not ask for.
  // "blocked" marks a stop caused by commands failing, so Saver does not keep retrying on its own.
  function stopSaver(s, reason = null, blocked = false) {
    if (s.saver?.state === 'running') s.saver = { ...s.saver, state: 'stopped', reason, blocked, stoppedAt: now() };
  }
  const saverSettings = s => { const { enabled, ...settings } = { ...SAVER_DEFAULTS, ...s.saverConfig }; return settings; };
  // Called once Daikin reports the aircon on: start a fresh cooling phase.
  async function beginSaver(s) {
    s.saver = { id: secret(), ...saverSettings(s), state: 'running', phase: 'on', phaseStart: now(), startedAt: now(), switches: 0, failures: 0 };
    s.nextPoll = now() + Math.min(POLL_ACTIVE, phaseMs(s.saver)); await record(s, 'saver-start');
  }
  async function command(s, power, source = 'manual') {
    if (power) { delete s.offWanted; s.onSentAt = now(); }
    if (s.mode === 'practice') s.status = { ...s.status, power, checkedAt: now() };
    else await client.control(s.token, power);
    // A successful POST is not proof that the unit physically changed state.
    s.status = await status(s);
    // The physical controller changes asynchronously; the first /me response can be stale.
    for (let attempt = 0; s.mode === 'live' && s.status.power !== power && attempt < 4; attempt++) {
      await pause(1500);
      s.status = await status(s);
    }
    const confirmed = s.status.power === power;
    if (!s.status.power) delete s.offWanted;
    s.lastResult = { at: now(), confirmed, message: confirmed ?
      `Daikin reports aircon ${power ? 'on' : 'off'}.` : 'Command sent; Daikin has not confirmed the change yet.' };
    s.nextPoll = now() + POLL_ACTIVE; await record(s, `${source}-${power ? 'on' : 'off'}`);
    return confirmed;
  }
  // Saver alternates cooling and coasting. Billing is per minute switched on, so every coasting minute is free.
  async function steer(s) {
    const v = s.saver;
    const on = s.status.power;
    if (on && s.session?.known && !s.session.mine) { stopSaver(s, "Your roommate's account is running the aircon, so Saver stopped and left it alone."); return; }
    if (on !== (v.phase === 'on') && !v.failures) {
      // Switched elsewhere (official app, remote or a roommate). Never fight it. An on during a rest is adopted
      // only on your wallet: cycling a roommate's session would move its charge to this account.
      if (on && s.session?.mine) { v.phase = 'on'; v.phaseStart = now(); return; }
      stopSaver(s, !on ? 'The aircon was switched off elsewhere, so Saver stopped.' : s.session?.known
        ? "Your roommate switched the aircon on with their account, so Saver stopped and left it alone."
        : 'The aircon was switched on outside this app during a rest, so Saver stopped and left it alone.');
      return;
    }
    if (now() - v.phaseStart < phaseMs(v)) return;
    const room = s.status.temperature;
    // Without a room reading, temperature mode falls back to its minimum on/off times.
    if (v.kind === 'thermostat' && room !== null && !(v.phase === 'on' ? room <= v.coolTo : room >= v.warmTo)) return;
    const want = v.phase !== 'on';
    if (await command(s, want, 'saver')) { v.phase = want ? 'on' : 'off'; v.phaseStart = now(); v.failures = 0; v.switches++; }
    else if (++v.failures >= 5) stopSaver(s, `Daikin did not confirm aircon ${want ? 'on' : 'off'} after five tries, so Saver stopped. Check your aircon.`, true);
  }
  async function poll(s) {
    try {
      s.status = await status(s);
      await record(s);
      if (s.offWanted) await settleOff(s);
      else if (s.saver?.state === 'running') await steer(s);
      // Saver only cycles your sessions: started here, or on your wallet from the remote or official app.
      else if (s.status.power && s.session?.mine && (s.saverConfig?.enabled ?? SAVER_DEFAULTS.enabled) && !s.saver?.blocked) await beginSaver(s);
    } catch (error) {
      if (error.status === 401) {
        s.token = null; s.mode = null; s.remember = false;
        stopSaver(s, 'Daikin sign-in expired, so Saver stopped. The aircon was left as it was.');
        if (s.timer?.state === 'scheduled') s.timer = { ...s.timer, state: 'failed', error: 'Daikin sign-in expired before the shutdown could be completed. Reconnect and set a new shutdown.' };
        s.lastResult = { at: now(), confirmed: false, message: 'Daikin sign-in expired. Reconnect to keep logging and controlling your aircon.' };
        return;
      }
      if (s.saver?.state === 'running' && ++s.saver.failures >= 10) stopSaver(s, 'Daikin could not be reached for ten checks, so Saver stopped. Check your aircon.', true);
    }
    const v = s.saver?.state === 'running' ? s.saver : null;
    s.nextPoll = now() + (s.offWanted && !s.offWanted.gaveUp ? OFF_RETRY_MS : v?.failures ? 20000 : v || s.status?.power ? POLL_ACTIVE : POLL_IDLE);
    // Wake exactly at the end of a phase rather than up to a minute late.
    const phaseEnd = v && !v.failures ? v.phaseStart + phaseMs(v) : 0;
    if (phaseEnd > now()) s.nextPoll = Math.min(s.nextPoll, phaseEnd);
  }
  // A turn-off is finished only when Daikin reports the unit off. Until then it is resent, and Saver never
  // starts, so an off that Daikin dropped cannot leave the aircon running or be turned back into a cooling cycle.
  async function settleOff(s) {
    const want = s.offWanted;
    if (!s.status.power) { delete s.offWanted; return; }
    if (want.gaveUp) return;
    if (want.tries >= OFF_RETRIES || now() - want.at > OFF_GIVE_UP_MS) {
      want.gaveUp = true;
      s.lastResult = { at: now(), confirmed: false, message: 'The aircon still reports on after repeated turn-off attempts. Check it in the room.' };
      return;
    }
    want.tries++;
    try { await command(s, false, 'retry'); } catch (error) { if (error.status === 401) throw error; }
  }
  async function exclusive(s, fn) {
    if (s.busy) throw new AppError(409, 'A request is already running. Please wait.');
    s.busy = true;
    try { return await fn(); } finally { s.busy = false; }
  }
  // Jobs are serialized with browser commands; only the current schedule can run.
  async function tick() {
    for (const [key, ticket] of loginTickets) if (ticket.expiresAt <= now()) loginTickets.delete(key);
    for (const [id, s] of sessions) {
      if (s.expiresAt <= now()) { if (!s.busy) { forget(s); sessions.delete(id); await persist(); } continue; }
      const timer = s.timer;
      if (!s.busy && (s.mode === 'live' || s.saver?.state === 'running') && s.nextPoll <= now() && !(timer?.state === 'scheduled' && timer.nextAttempt <= now())) {
        await exclusive(s, () => poll(s)); await persist();
      }
      if (!timer || timer.nextAttempt > now() || timer.state !== 'scheduled' || s.busy) continue;
      await exclusive(s, async () => {
        // Only a first attempt can be stale; retries after a slow Daikin reply are still wanted.
        if (!timer.attempts && now() - timer.dueAt > 120000) {
          timer.state = 'failed';
          timer.error = 'Timer missed while the server was unavailable. Check your aircon manually.';
          s.lastResult = { at: now(), confirmed: false, message: timer.error };
          await persist(); return;
        }
        // End Saver before anything else, so a failed or slow shutdown can never be undone by Saver
        // turning the aircon back on after a rest.
        stopSaver(s, 'Your shutdown timer turned the aircon off, so Saver stopped.');
        s.offWanted ??= { at: now(), tries: 0 };
        timer.attempts++;
        let confirmed = false;
        try {
          confirmed = await command(s, false, 'timer');
        } catch (error) {
          s.lastResult = { at: now(), confirmed: false, message: error instanceof AppError ? error.message : 'Shutdown failed.' };
          timer.error = s.lastResult.message;
          // During a Saver rest the unit is already off, and Daikin may refuse a redundant off. That is a success.
          if (error.status !== 401) {
            try { s.status = await status(s); confirmed = s.status.power === false; } catch { /* Retry below. */ }
            if (confirmed) { delete s.offWanted; s.lastResult = { at: now(), confirmed, message: 'Daikin reports aircon off.' }; }
          }
          if (error.status === 401) { s.token = null; s.mode = null; s.remember = false; timer.state = 'failed'; stopSaver(s, 'Daikin sign-in expired, so Saver stopped.'); await persist(); return; }
        }
        if (confirmed) { timer.state = 'completed'; delete timer.error; }
        else if (timer.attempts >= 3) {
          timer.state = 'failed';
          timer.error ??= 'Daikin has not confirmed aircon off after three attempts. Check your aircon manually.';
        }
        else timer.nextAttempt = now() + 15000;
        await persist();
      });
    }
  }
  function limited(key, max) {
    const stamp = now();
    for (const [k, v] of rate) if (stamp - v.start > 60000) rate.delete(k);
    const entry = rate.get(key) ?? { start: stamp, count: 0 };
    entry.count++; rate.set(key, entry);
    if (entry.count > max) throw new AppError(429, 'Too many requests. Wait a minute and try again.');
  }
  async function handler(req, res) {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const address = req.socket.localAddress;
      const host = req.headers.host;
      const expectedHost = `127.0.0.1:${req.socket.localPort}`;
      if (!hostedOrigin && (host !== expectedHost || !['127.0.0.1', '::ffff:127.0.0.1'].includes(address))) throw new AppError(403, 'Use the printed local address.');
      const origin = hostedOrigin ?? `http://${expectedHost}`;
      const url = new URL(req.url, origin);
      if (url.search) throw new AppError(400, 'Query parameters are not accepted.');
      // Extension capture is narrowly authenticated by a one-use, short-lived ticket,
      // issued through the normal same-origin session/CSRF protected route.
      if (url.pathname === '/api/login/capture') {
        if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') throw new AppError(405, 'Expected a JSON POST.');
        const key = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
        const ticket = loginTickets.get(key);
        if (!ticket || ticket.expiresAt <= now() || ticket.claimed) throw new AppError(401, 'Login request expired. Start sign-in again.');
        const s = sessions.get(ticket.sessionId);
        if (!s || s.expiresAt <= now()) throw new AppError(401, 'Local session expired.');
        let raw = ''; for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 10000) throw new AppError(413, 'Request too large.'); }
        let body; try { body = JSON.parse(raw); } catch { throw new AppError(400, 'Invalid JSON.'); }
        if (!body || !parseLoginReturn(body.returnUrl)) throw new AppError(400, 'Expected a Daikin login return URL.');
        ticket.claimed = true;
        try {
          await exclusive(s, async () => { await connect(s, body.returnUrl, ticket.remember); await persist(); });
        } catch (error) {
          s.lastResult = { at: now(), confirmed: false, message: error instanceof AppError ? error.message : 'Automatic login failed. Please sign in again.' };
          throw error;
        } finally { loginTickets.delete(key); s.loginTicket = null; }
        reply(200, { connected: true }); return;
      }
      // The login helper navigates back from Daikin. Serve only the public
      // homepage on top-level cross-site navigation; never session/API data.
      const publicNavigation = req.method === 'GET' && url.pathname === '/'
        && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers['sec-fetch-site'] === 'cross-site' && !publicNavigation) throw new AppError(403, 'Cross-site requests are blocked.');
      if (req.method === 'GET' && ASSETS.has(url.pathname)) {
        const [file, type] = ASSETS.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type });
        res.end(await readFile(new URL(file, import.meta.url))); return;
      }
      const allowed = { '/api/session': 'GET', '/api/state': 'GET', '/api/connect': 'POST', '/api/temperature': 'POST',
        '/api/practice': 'POST', '/api/status': 'POST', '/api/power': 'POST', '/api/timer': 'POST', '/api/saver': 'POST', '/api/history': 'POST', '/api/usage': 'POST', '/api/disconnect': 'POST', '/api/login/start': 'POST', '/api/login/cancel': 'POST' };
      if (!allowed[url.pathname]) throw new AppError(404, 'Not found.');
      if (req.method !== allowed[url.pathname]) throw new AppError(405, 'Method not allowed.');
      limited('all', 240);
      const match = /(?:^|;\s*)hall_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
      let id = sharedRoom ? ROOM_ID : match?.[1]; let s = sessions.get(id);
      if (s && s.expiresAt <= now()) { if (!s.busy) { forget(s); sessions.delete(id); } s = null; }
      if (url.pathname === '/api/session') {
        if (!s) {
          if (sessions.size >= 20) throw new AppError(429, 'Too many local sessions. Restart the demo to clear them.');
          id = sharedRoom ? ROOM_ID : secret(); s = { csrf: secret(), token: null, mode: null, status: null, timer: null,
            lastResult: null, busy: false, remember: false, loginTicket: null, saver: null, saverConfig: null, lastRow: null, ledger: false, nextPoll: 0, expiresAt: sharedRoom ? Number.MAX_SAFE_INTEGER : now() + sessionMs }; sessions.set(id, s);
        }
        // HTTP loopback only. Production must use HTTPS and a Secure cookie.
        if (!sharedRoom) res.setHeader('Set-Cookie', `hall_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expiresAt - now()) / 1000)}${hostedOrigin ? '; Secure' : ''}`);
        if (hostedOrigin) await persist();
        reply(200, { csrf: s.csrf, ...publicState(s) }); return;
      }
      if (!s) throw new AppError(401, 'Your local session expired. Reload and reconnect.');
      if (req.method === 'GET') { reply(200, publicState(s)); return; }
      if (req.headers.origin !== origin || !equal(req.headers['x-csrf-token'], s.csrf)) throw new AppError(403, 'Request verification failed. Reload the page.');
      if (req.headers['content-type'] !== 'application/json') throw new AppError(415, 'Expected JSON.');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 10000) throw new AppError(413, 'Request too large.'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new AppError(400, 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Expected an object.');
      let loginTicket, rows, usage;
      await exclusive(s, async () => {
        if (url.pathname === '/api/login/start') {
          limited('connect', 6);
          if (s.mode === 'live') throw new AppError(409, 'Disconnect before connecting another account.');
          if (s.loginTicket) loginTickets.delete(s.loginTicket);
          loginTicket = secret(); s.loginTicket = loginTicket;
          loginTickets.set(loginTicket, { sessionId: id, expiresAt: Math.min(now() + 600000, s.expiresAt), remember: body.remember !== false, claimed: false });
          return;
        }
        if (url.pathname === '/api/login/cancel') { if (s.loginTicket) loginTickets.delete(s.loginTicket); s.loginTicket = null; return; }
        if (url.pathname === '/api/disconnect') {
          if (s.timer?.state === 'scheduled' && body.confirm !== true) throw new AppError(409, 'Removing this connection cancels its pending shutdown. Confirm removal first.');
          const timer = s.timer ? { ...s.timer, state: s.timer.state === 'scheduled' ? 'cancelled' : s.timer.state } : null;
          forget(s); s.timer = timer; if (!sharedRoom) s.csrf = secret(); return;
        }
        if (url.pathname === '/api/connect') {
          limited('connect', 6);
          await connect(s, body.token, body.remember !== false); return;
        }
        if (url.pathname === '/api/practice') {
          if (s.mode === 'live') throw new AppError(409, 'Disconnect the real aircon before entering practice mode.');
          forget(s); s.mode = 'practice'; s.status = { power: false, temperature: 27, setpoint: 25, checkedAt: now() }; return;
        }
        if (url.pathname === '/api/timer' && body.cancel === true) {
          if (s.timer?.state === 'scheduled') s.timer = { ...s.timer, state: 'cancelled' }; return;
        }
        if (!s.mode) throw new AppError(401, 'Connect your aircon first.');
        if (url.pathname === '/api/history') {
          if (!Number.isInteger(body.hours) || body.hours < 1 || body.hours > 744) throw new AppError(400, 'Choose a history range from 1 to 744 hours.');
          rows = await history.read(now() - body.hours * 3600000); return;
        }
        if (url.pathname === '/api/usage') {
          usage = [];
          for (const id of (await history.months()).sort()) usage.push(...Object.values(await history.month(id) ?? {}));
          return;
        }
        if (url.pathname === '/api/status') { s.status = await status(s); await record(s); return; }
        if (url.pathname === '/api/saver') {
          const L = SAVER_LIMITS;
          const config = { ...SAVER_DEFAULTS, ...s.saverConfig };
          if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AppError(400, 'Saver must be on or off.');
          if (body.enabled === undefined && body.settings === undefined) throw new AppError(400, 'Nothing to change.');
          if (body.settings !== undefined) {
            const v = body.settings;
            const minutes = value => Number.isInteger(value) && value >= L.minMinutes && value <= L.maxMinutes;
            if (!v || !['interval', 'thermostat'].includes(v.kind)) throw new AppError(400, 'Choose fixed intervals or room temperature.');
            if (!minutes(v.firstMinutes) || !minutes(v.onMinutes) || !minutes(v.offMinutes)) throw new AppError(400, `Choose times from ${L.minMinutes} to ${L.maxMinutes} minutes.`);
            if (!Number.isInteger(v.coolTo) || !Number.isInteger(v.warmTo) || v.coolTo < L.minTemperature || v.warmTo > L.maxTemperature || v.warmTo <= v.coolTo) {
              throw new AppError(400, `Choose a switch-off temperature below the switch-on temperature, between ${L.minTemperature} and ${L.maxTemperature}°C.`);
            }
            Object.assign(config, { kind: v.kind, firstMinutes: v.firstMinutes, onMinutes: v.onMinutes, offMinutes: v.offMinutes, coolTo: v.coolTo, warmTo: v.warmTo });
          }
          if (body.enabled !== undefined) config.enabled = body.enabled;
          s.saverConfig = config;
          const running = s.saver?.state === 'running';
          if (running && config.enabled) { Object.assign(s.saver, saverSettings(s)); s.nextPoll = now(); return; }
          if (running) {
            // Switching Saver off means "keep cooling", so end a rest period by turning the aircon back on.
            const resting = s.saver.phase === 'off';
            stopSaver(s);
            if (resting) { limited('power', 12); await command(s, true); }
            return;
          }
          if (body.enabled === true) { s.status = await status(s); if (s.status.power && s.session?.mine) await beginSaver(s); }
          return;
        }
        if (url.pathname === '/api/temperature') {
          if (!Number.isInteger(body.setpoint) || body.setpoint < TEMPERATURE_LIMITS.min || body.setpoint > TEMPERATURE_LIMITS.max) {
            throw new AppError(400, `Choose a whole-number temperature from ${TEMPERATURE_LIMITS.min} to ${TEMPERATURE_LIMITS.max}°C.`);
          }
          limited('power', 12);
          // The observed controller command includes power. Check fresh status
          // and refuse while off, so applying a temperature does not start cooling.
          s.status = await status(s);
          if (!s.status.power) throw new AppError(409, 'Turn the aircon on before changing its temperature.');
          if (s.mode === 'practice') s.status = { ...s.status, setpoint: body.setpoint, checkedAt: now() };
          else await client.temperature(s.token, body.setpoint);
          s.status = await status(s);
          for (let attempt = 0; s.mode === 'live' && s.status.setpoint !== body.setpoint && attempt < 4; attempt++) {
            await pause(1500); s.status = await status(s);
          }
          const confirmed = s.status.setpoint === body.setpoint;
          s.lastResult = { at: now(), confirmed, message: confirmed ? `Daikin reports target temperature ${body.setpoint}°C.` : 'Temperature command sent; Daikin has not confirmed the target yet.' };
          // Adjusting temperature retains the sleep timer.
          return;
        }
        if (url.pathname === '/api/power') {
          if (typeof body.power !== 'boolean') throw new AppError(400, 'Power must be true or false.');
          limited('power', 12);
          // Turn off always ends Saver. Turn on starts a fresh cooling phase while Saver is enabled.
          const saving = body.power && (s.saverConfig?.enabled ?? SAVER_DEFAULTS.enabled);
          if (!saving) stopSaver(s);
          // Remember the off before sending it, so a lost or refused command is retried rather than forgotten.
          if (!body.power) s.offWanted = { at: now(), tries: 0 };
          let confirmed = false;
          try { confirmed = await command(s, body.power); }
          catch (error) {
            if (body.power || !(error instanceof AppError) || error.status === 401 || s.mode !== 'live') throw error;
            s.nextPoll = now() + OFF_RETRY_MS;
            s.lastResult = { at: now(), confirmed: false, message: `${error.message} The app will keep trying to turn the aircon off.` };
            return;
          }
          if (!body.power && !confirmed) s.nextPoll = now() + OFF_RETRY_MS;
          if (saving && confirmed) await beginSaver(s);
          if (!body.power && confirmed && s.timer?.state === 'scheduled') s.timer = { ...s.timer, state: 'completed', completedBy: 'manual' };
          return;
        }
        if (url.pathname === '/api/timer') {
          const hasMinutes = Object.hasOwn(body, 'minutes');
          const hasDue = Object.hasOwn(body, 'dueAt');
          if (hasMinutes === hasDue) throw new AppError(400, 'Choose a duration or a shutdown time, not both.');
          if (hasMinutes && (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 1440)) throw new AppError(400, 'Choose a timer from 1 to 1440 minutes.');
          const dueAt = hasMinutes ? now() + body.minutes * 60000 : body.dueAt;
          if (!Number.isSafeInteger(dueAt) || dueAt <= now() || dueAt > now() + 86400000) throw new AppError(400, 'Choose a future shutdown within the next 24 hours.');
          if (dueAt >= s.expiresAt) throw new AppError(400, 'The timer would outlive your session. Reconnect in a new session.');
          s.timer = { id: secret(), dueAt, timezone: 'Asia/Singapore', nextAttempt: dueAt, attempts: 0, state: 'scheduled' }; return;
        }
      });
      await persist();
      reply(200, { csrf: s.csrf, ...publicState(s), ...(loginTicket ? { loginTicket } : {}), ...(rows ? { history: rows } : {}), ...(usage ? { usage } : {}) });
    } catch (error) {
      if (error.status === 401 && !['/api/connect', '/api/login/capture'].includes(req.url)) {
        const id = sharedRoom ? ROOM_ID : /(?:^|;\s*)hall_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
        const s = sessions.get(id);
        if (s?.mode === 'live') {
          s.token = null; s.mode = null; s.remember = false;
          stopSaver(s, 'Daikin sign-in expired, so Saver stopped. The aircon was left as it was.');
          if (s.timer?.state === 'scheduled') s.timer = { ...s.timer, state: 'failed', error: 'Daikin sign-in expired before the shutdown could be completed. Reconnect and set a new shutdown.' };
          s.lastResult = { at: now(), confirmed: false, message: 'Daikin sign-in expired. Reconnect; any pending shutdown could not be completed.' };
          await persist().catch(() => {});
        }
      }
      reply(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Request failed. Please try again.' });
    }
  }
  return { handler, tick, csrf: () => sessions.get(ROOM_ID)?.csrf, nextAlarm: () => Math.min(...[...sessions.values()].flatMap(s => [s.expiresAt, ...(s.timer?.state === 'scheduled' ? [s.timer.nextAttempt] : [])])), close: () => { for (const s of sessions.values()) forget(s); sessions.clear(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
  const directory = join(homedir(), '.local', 'share', 'better-hall-aircon');
  const vault = await createVault(directory);
  const app = createApp({ vault, initialRecords: await vault.load(), history: fileHistory(join(directory, 'history.jsonl')) });
  const server = http.createServer(app.handler);
  server.on('error', error => {
    clearInterval(scheduler); app.close();
    console.error(error.code === 'EADDRINUSE' ? 'Port is in use. Choose another PORT.' :
      'Could not start the local server. Run npm start in a terminal that permits local network listening.');
    process.exitCode = 1;
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  const scheduler = setInterval(() => { void app.tick().catch(() => {}); }, 1000);
  server.listen(port, '127.0.0.1', () => console.log(`Hall Aircon demo: http://127.0.0.1:${port}\nLocal only. Keep this process and computer awake for timers. Remembered connections are encrypted in your private user data directory.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    clearInterval(scheduler); app.close(); server.close();
  });
}
