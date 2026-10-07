import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createVault } from './vault.mjs';

const UPSTREAM = 'https://apintu-prod.daikinpayu.com';
// Conservative demo bounds, not a claim about every NTU controller's limits.
const TEMPERATURE_LIMITS = { min: 22, max: 30 };
const ASSETS = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
]);
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
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
  // Deliberately omit name, matric number, room address and all credentials.
  return { power: Number(ac.power) === 1, temperature: numberOrNull(ac.current_temperature),
    setpoint: numberOrNull(ac.setpoint), checkedAt: Date.now() };
}
export function createDaikinClient(fetchImpl = fetch) {
  async function request(path, token, body) {
    let response;
    try {
      response = await fetchImpl(UPSTREAM + path, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json',
          'User-Agent': 'Dart/3.0 (dart:io)', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } : {}) },
        ...(body ? { body: new URLSearchParams(body) } : {}),
      });
    } catch { throw new AppError(502, 'Cannot reach Daikin. Check your internet connection and try again.'); }
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
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), vault = null, initialRecords = [], hostedOrigin = null } = {}) {
  const sessions = new Map();
  const rate = new Map();
  const loginTickets = new Map();
  for (const record of initialRecords.slice(0, 20)) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(record.id) || record.expiresAt <= now() || (!hostedOrigin && record.mode !== 'live')) continue;
    if (record.token) parseToken(record.token);
    sessions.set(record.id, { ...record, csrf: hostedOrigin ? record.csrf : secret(), busy: false, loginTicket: null });
  }
  const persist = async () => {
    if (!vault) return;
    const records = [...sessions.entries()].filter(([, s]) => s.expiresAt > now() && (hostedOrigin || (s.mode === 'live' && s.remember))).map(([id, s]) => ({
      id, csrf: hostedOrigin ? s.csrf : undefined, token: s.token, mode: s.mode, remember: s.remember, status: s.status, timer: s.timer, lastResult: s.lastResult, expiresAt: s.expiresAt,
    }));
    try { await vault.save(records); } catch { throw new AppError(503, 'Could not save the connection safely. Check local storage and try again.'); }
  };
  function publicState(s) {
    return { connected: Boolean(s.mode), mode: s.mode, status: s.status, timer: s.timer,
      lastResult: s.lastResult, busy: s.busy, expiresAt: s.expiresAt, remembered: Boolean(s.remember && vault), temperatureLimits: TEMPERATURE_LIMITS,
      loginWaiting: Boolean(s.loginTicket && loginTickets.has(s.loginTicket)), loginExpiresAt: loginTickets.get(s.loginTicket)?.expiresAt ?? null };
  }
  function forget(s) {
    if (s.loginTicket) loginTickets.delete(s.loginTicket);
    s.loginTicket = null; s.token = null; s.mode = null; s.timer = null; s.status = null; s.lastResult = null; s.remember = false;
  }
  async function connect(s, credential, remember) {
    if (hostedOrigin && !remember) throw new AppError(400, 'Cloud timers require a remembered connection. Keep the checkbox selected.');
    const hash = parseLoginReturn(credential);
    const token = hash ? await client.exchange(hash) : parseAirconCredential(credential);
    const checked = await client.status(token);
    forget(s); s.token = token; s.mode = 'live'; s.status = checked; s.remember = remember;
  }
  async function status(s) {
    if (s.mode === 'practice') return { ...s.status, checkedAt: now() };
    return client.status(s.token);
  }
  async function command(s, power) {
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
    s.lastResult = { at: now(), confirmed, message: confirmed ?
      `Daikin reports aircon ${power ? 'on' : 'off'}.` : 'Command sent; Daikin has not confirmed the change yet.' };
    return confirmed;
  }
  async function exclusive(s, fn) {
    if (s.busy) throw new AppError(409, 'A request is already running. Please wait.');
    s.busy = true;
    try { return await fn(); } finally { s.busy = false; }
  }
  // One due job at a time per session. Version/identity checks prevent cancelled jobs being rescheduled.
  async function tick() {
    for (const [key, ticket] of loginTickets) if (ticket.expiresAt <= now()) loginTickets.delete(key);
    for (const [id, s] of sessions) {
      if (s.expiresAt <= now()) { if (!s.busy) { forget(s); sessions.delete(id); await persist(); } continue; }
      const timer = s.timer;
      if (!timer || timer.nextAttempt > now() || timer.state !== 'scheduled' || s.busy) continue;
      await exclusive(s, async () => {
        if (now() - timer.dueAt > 120000) {
          timer.state = 'failed';
          s.lastResult = { at: now(), confirmed: false, message: 'Timer missed while the server was unavailable. Check your aircon manually.' };
          await persist(); return;
        }
        timer.attempts++;
        try {
          const confirmed = await command(s, false);
          if (confirmed) { timer.state = 'completed'; await persist(); return; }
        } catch (error) {
          s.lastResult = { at: now(), confirmed: false, message: error instanceof AppError ? error.message : 'Shutdown failed.' };
          if (error.status === 401) { s.token = null; s.mode = null; s.remember = false; timer.state = 'failed'; await persist(); return; }
        }
        if (timer.attempts >= 3) timer.state = 'failed';
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
        '/api/practice': 'POST', '/api/status': 'POST', '/api/power': 'POST', '/api/timer': 'POST', '/api/disconnect': 'POST', '/api/login/start': 'POST', '/api/login/cancel': 'POST' };
      if (!allowed[url.pathname]) throw new AppError(404, 'Not found.');
      if (req.method !== allowed[url.pathname]) throw new AppError(405, 'Method not allowed.');
      limited('all', 240);
      const match = /(?:^|;\s*)hall_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
      let id = match?.[1]; let s = sessions.get(id);
      if (s && s.expiresAt <= now()) { if (!s.busy) { forget(s); sessions.delete(id); } s = null; }
      if (url.pathname === '/api/session') {
        if (!s) {
          if (sessions.size >= 20) throw new AppError(429, 'Too many local sessions. Restart the demo to clear them.');
          id = secret(); s = { csrf: secret(), token: null, mode: null, status: null, timer: null,
            lastResult: null, busy: false, remember: false, loginTicket: null, expiresAt: now() + sessionMs }; sessions.set(id, s);
        }
        // HTTP loopback only. Production must use HTTPS and a Secure cookie.
        res.setHeader('Set-Cookie', `hall_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expiresAt - now()) / 1000)}${hostedOrigin ? '; Secure' : ''}`);
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
      let loginTicket;
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
        if (url.pathname === '/api/disconnect') { forget(s); s.csrf = secret(); return; }
        if (url.pathname === '/api/connect') {
          limited('connect', 6);
          await connect(s, body.token, body.remember !== false); return;
        }
        if (url.pathname === '/api/practice') {
          if (s.mode === 'live') throw new AppError(409, 'Disconnect the real aircon before entering practice mode.');
          forget(s); s.mode = 'practice'; s.status = { power: false, temperature: 27, setpoint: 25, checkedAt: now() }; return;
        }
        if (!s.mode) throw new AppError(401, 'Connect your aircon first.');
        if (url.pathname === '/api/status') { s.status = await status(s); return; }
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
          // Unlike manual power commands, adjusting temperature retains the sleep timer.
          return;
        }
        if (url.pathname === '/api/power') {
          if (typeof body.power !== 'boolean') throw new AppError(400, 'Power must be true or false.');
          limited('power', 12); s.timer = null;
          try { await command(s, body.power); } finally { await persist(); }
          return;
        }
        if (url.pathname === '/api/timer') {
          if (body.cancel === true) { s.timer = null; return; }
          if (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 480) throw new AppError(400, 'Choose a timer from 1 to 480 minutes.');
          const dueAt = now() + body.minutes * 60000;
          if (dueAt >= s.expiresAt) throw new AppError(400, 'The timer would outlive your session. Reconnect in a new session.');
          s.timer = { dueAt, nextAttempt: dueAt, attempts: 0, state: 'scheduled' }; return;
        }
      });
      await persist();
      reply(200, { csrf: s.csrf, ...publicState(s), ...(loginTicket ? { loginTicket } : {}) });
    } catch (error) {
      if (error.status === 401 && !['/api/connect', '/api/login/capture'].includes(req.url)) {
        const id = /(?:^|;\s*)hall_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
        const s = sessions.get(id);
        if (s?.mode === 'live') { forget(s); await persist().catch(() => {}); }
      }
      reply(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Request failed. Please try again.' });
    }
  }
  return { handler, tick, nextAlarm: () => Math.min(...[...sessions.values()].flatMap(s => [s.expiresAt, ...(s.timer?.state === 'scheduled' ? [s.timer.nextAttempt] : [])])), close: () => { for (const s of sessions.values()) forget(s); sessions.clear(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
  const directory = join(homedir(), '.local', 'share', 'better-hall-aircon');
  const vault = await createVault(directory);
  const app = createApp({ vault, initialRecords: await vault.load() });
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
