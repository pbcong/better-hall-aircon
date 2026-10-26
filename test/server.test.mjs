import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../vault.mjs';
import { AppError, createApp, createDaikinClient, parseToken, parseAirconCredential, parseLoginReturn, normalizeStatus } from '../server.mjs';

const TOKEN = 'test-aircon-token-0123456789';
async function fixture(t, options = {}) {
  let clock = 1700000000000;
  let power = false;
  let setpoint = 25;
  let failure = null;
  const commands = [];
  const temperatures = [];
  const client = {
    status: async token => { assert.equal(token, TOKEN); if (failure) throw failure; return { power, temperature: 26, setpoint, checkedAt: clock }; },
    control: async (token, next) => { assert.equal(token, TOKEN); commands.push(next); if (failure) throw failure; power = next; },
    temperature: async (token, next) => { assert.equal(token, TOKEN); temperatures.push(next); if (failure) throw failure; setpoint = next; },
  };
  const app = createApp({ client, now: () => clock, pause: async () => {}, ...options });
  // Invoke the actual HTTP handler without sockets; sandboxed runners may forbid listen().
  const origin = 'http://127.0.0.1:3000';
  t.after(() => app.close());
  let cookie = '', csrf = '';
  async function request(path, body, overrides = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? 'GET' : 'POST'; req.url = path;
    req.socket = { localAddress: '127.0.0.1', localPort: 3000 };
    req.headers = Object.fromEntries(Object.entries({ Host: '127.0.0.1:3000', Cookie: cookie,
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...overrides }).map(([k, v]) => [k.toLowerCase(), v]));
    const headers = new Headers(); let code, raw;
    const res = { setHeader: (key, value) => headers.set(key, value),
      writeHead: (status, values = {}) => { code = status; Object.entries(values).forEach(([key, value]) => headers.set(key, value)); },
      end: value => { raw = value; } };
    await app.handler(req, res);
    const setCookie = headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const value = headers.get('content-type')?.includes('application/json') ? JSON.parse(raw) : raw.toString();
    if (value.csrf) csrf = value.csrf;
    return { code, value, headers };
  }
  return { app, client, request, commands, temperatures, advance: ms => { clock += ms; }, fail: error => { failure = error; } };
}

const returnUrl = 'https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/fake-login-code-0123456789';
const autoClient = { exchange: async () => TOKEN, status: async () => ({ power: true, temperature: 25 }), control: async () => assert.fail('Login must not control the aircon') };
test('temperature changes are authenticated, bounded, confirmed and preserve an existing shutdown', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/temperature', { setpoint: 22 })).code, 401);
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  assert.equal((await f.request('/api/temperature', { setpoint: 22 })).code, 409);
  assert.deepEqual(f.temperatures, []);
  await f.request('/api/power', { power: true });
  await f.request('/api/timer', { minutes: 60 });
  const scheduled = (await f.request('/api/state')).value.timer;
  assert.equal((await f.request('/api/temperature', { setpoint: 22 }, { 'X-CSRF-Token': 'forged' })).code, 403);
  assert.equal((await f.request('/api/temperature', { setpoint: 22 }, { Origin: 'https://attacker.example' })).code, 403);
  for (const invalid of [21, 31, 22.5, '22', null, true]) {
    assert.equal((await f.request('/api/temperature', { setpoint: invalid })).code, 400);
  }
  for (const setpoint of [22, 30]) {
    const result = await f.request('/api/temperature', { setpoint });
    assert.equal(result.code, 200); assert.equal(result.value.status.setpoint, setpoint);
    assert.equal(result.value.status.power, true); assert.equal(result.value.lastResult.confirmed, true);
    assert.deepEqual(result.value.timer, scheduled);
  }
  assert.deepEqual(f.temperatures, [22, 30]); assert.deepEqual(f.commands, [true]);
});
test('temperature command checks fresh power and does not turn on a unit switched off elsewhere', async t => {
  let power = true;
  const f = await fixture(t, { client: {
    status: async () => ({ power, temperature: 25, setpoint: 24 }),
    temperature: async () => assert.fail('Must not send temperature while off'),
  } });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  power = false;
  assert.equal((await f.request('/api/temperature', { setpoint: 22 })).code, 409);
});
test('temperature confirmation waits for reported setpoint and does not invent success', async t => {
  let calls = 0, sent = false, confirm = true;
  const f = await fixture(t, { client: {
    status: async () => ({ power: true, temperature: 26, setpoint: sent && ++calls >= 3 && confirm ? 22 : 25 }),
    temperature: async (_token, setpoint) => { assert.equal(setpoint, 22); sent = true; },
  } });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  const result = await f.request('/api/temperature', { setpoint: 22 });
  assert.equal(result.value.lastResult.confirmed, true); assert.equal(calls, 3);
  confirm = false;
  const stale = await f.request('/api/temperature', { setpoint: 22 });
  assert.equal(stale.value.lastResult.confirmed, false); assert.equal(stale.value.status.setpoint, 25);
});
test('practice temperature changes never contact Daikin', async t => {
  const f = await fixture(t, { client: {
    status: async () => assert.fail('No live status in practice'),
    temperature: async () => assert.fail('No live temperature in practice'),
    control: async () => assert.fail('No live power in practice'),
  } });
  await f.request('/api/session'); await f.request('/api/practice', {});
  await f.request('/api/power', { power: true }); await f.request('/api/timer', { minutes: 1 });
  const result = await f.request('/api/temperature', { setpoint: 22 });
  assert.equal(result.value.status.setpoint, 22); assert.equal(result.value.timer.state, 'scheduled');
});
test('temperature transport uses only the fixed Daikin control endpoint and expected form fields', async () => {
  const client = createDaikinClient(async (url, init) => {
    assert.equal(url, 'https://apintu-prod.daikinpayu.com/v2/ac/control');
    assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.body.toString(), 'power=1&setpoint=22'); assert.equal(init.redirect, 'error');
    return Response.json({ success: true });
  });
  await client.temperature(TOKEN, 22);
});
test('login return can navigate to the public homepage but cross-site API requests stay blocked', async t => {
  const f = await fixture(t);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const page = await f.request('/', undefined, navigation);
  assert.equal(page.code, 200);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.ok(page.value.includes('Connect your aircon'));
  assert.equal((await f.request('/', undefined, { ...navigation, 'Sec-Fetch-Dest': 'iframe' })).code, 403);
  assert.equal((await f.request('/', undefined, { ...navigation, 'Sec-Fetch-Mode': 'cors' })).code, 403);
  assert.equal((await f.request('/api/session', undefined, navigation)).code, 403);
  await f.request('/api/session');
  assert.equal((await f.request('/api/state', undefined, navigation)).code, 403);
  assert.equal((await f.request('/api/power', { power: false }, navigation)).code, 403);
  assert.equal((await f.request('/app.js', undefined, navigation)).code, 403);
  assert.deepEqual(f.commands, []);
});
test('automatic capture uses a single-use ticket and exposes no credential or ticket in state', async t => {
  const f = await fixture(t, { client: autoClient });
  await f.request('/api/session');
  const start = await f.request('/api/login/start', { remember: true });
  assert.equal(start.code, 200); assert.equal(start.value.loginWaiting, true);
  const ticket = start.value.loginTicket;
  assert.equal((await f.request('/api/state')).value.loginTicket, undefined);
  const capture = await f.request('/api/login/capture', { returnUrl }, { Authorization: `Bearer ${ticket}`, Cookie: '', Origin: 'chrome-extension://test', 'Sec-Fetch-Site': 'cross-site', 'X-CSRF-Token': '' });
  assert.equal(capture.code, 200);
  assert.equal((await f.request('/api/state')).value.connected, true);
  assert.equal((await f.request('/api/login/capture', { returnUrl }, { Authorization: `Bearer ${ticket}` })).code, 401);
  assert.ok(!JSON.stringify((await f.request('/api/state')).value).includes(TOKEN));
});
test('cancelled, expired, forged and foreign-host returns cannot authenticate', async t => {
  const f = await fixture(t, { client: autoClient }); await f.request('/api/session');
  const start = await f.request('/api/login/start', {});
  const ticket = start.value.loginTicket;
  assert.equal((await f.request('/api/login/capture', { returnUrl }, { Authorization: `Bearer ${'A'.repeat(43)}` })).code, 401);
  assert.equal((await f.request('/api/login/capture', { returnUrl: returnUrl.replace('cmsntu-prod.daikinpayu.com', 'attacker.example') }, { Authorization: `Bearer ${ticket}` })).code, 400);
  await f.request('/api/login/cancel', {});
  assert.equal((await f.request('/api/login/capture', { returnUrl }, { Authorization: `Bearer ${ticket}` })).code, 401);
  const again = await f.request('/api/login/start', {}); f.advance(600001);
  assert.equal((await f.request('/api/login/capture', { returnUrl }, { Authorization: `Bearer ${again.value.loginTicket}` })).code, 401);
  assert.equal((await f.request('/api/state')).value.connected, false);
});
test('remembered connection and pending timer recover with the same browser session after restart', async t => {
  let records = [];
  const vault = { save: async value => { records = structuredClone(value); } };
  const f = await fixture(t, { vault });
  const session = await f.request('/api/session'); const cookie = session.headers.get('set-cookie').split(';')[0];
  await f.request('/api/connect', { token: TOKEN, remember: true });
  await f.request('/api/timer', { minutes: 1 });
  assert.equal(records.length, 1); assert.equal(records[0].token, TOKEN);
  const oldCsrf = session.value.csrf;
  f.app.close();
  const restored = await fixture(t, { vault, initialRecords: records });
  const status = await restored.request('/api/session', undefined, { Cookie: cookie });
  assert.equal(status.value.connected, true); assert.equal(status.value.remembered, true);
  assert.notEqual(status.value.csrf, oldCsrf);
  restored.advance(60000); await restored.app.tick();
  assert.equal((await restored.request('/api/state')).value.timer.state, 'completed');
  assert.deepEqual(restored.commands, [false]);
  await restored.request('/api/disconnect', {}); assert.deepEqual(records, []);
});
test('unremembered credentials are not saved; overdue recovered timers do not send stale commands', async t => {
  let records = []; const vault = { save: async value => { records = structuredClone(value); } };
  const f = await fixture(t, { vault }); await f.request('/api/session');
  await f.request('/api/connect', { token: TOKEN, remember: false }); assert.deepEqual(records, []);
  await f.request('/api/timer', { minutes: 1 }); f.advance(180001); await f.app.tick();
  assert.deepEqual(f.commands, []); assert.equal((await f.request('/api/state')).value.timer.state, 'failed');
});
test('failed power command preserves the saved shutdown', async t => {
  let records = []; const vault = { save: async value => { records = structuredClone(value); } };
  const f = await fixture(t, { vault }); await f.request('/api/session');
  await f.request('/api/connect', { token: TOKEN }); await f.request('/api/timer', { minutes: 1 });
  f.fail(new Error('offline')); assert.equal((await f.request('/api/power', { power: true })).code, 500);
  assert.equal(records[0].timer.state, 'scheduled');
});
test('vault encrypts, survives reopen, authenticates ciphertext and enforces private key permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hall-vault-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = await createVault(directory);
  const records = [{ token: TOKEN, id: 'PRIVATE_SESSION' }];
  await Promise.all([vault.save([]), vault.save(records)]);
  const file = join(directory, 'state.enc'); const bytes = await readFile(file);
  assert.ok(!bytes.includes(Buffer.from(TOKEN))); assert.ok(!bytes.includes(Buffer.from('PRIVATE_SESSION')));
  assert.deepEqual(await (await createVault(directory)).load(), records);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'key'))).mode & 0o077, 0);
  bytes[bytes.length - 1] ^= 1; await writeFile(file, bytes);
  await assert.rejects(vault.load());
});

test('token validation rejects passwords, URLs and header injection', () => {
  for (const invalid of ['password', 'https://ntu.edu.sg/?token=secret', `${TOKEN}\r\nBad: yes`, null]) assert.throws(() => parseToken(invalid));
  assert.equal(parseToken(`Bearer ${TOKEN}`), TOKEN);
});
test('status allowlist omits identity and rejects unknown power', () => {
  const normalized = normalizeStatus({ data: { name: 'PRIVATE', matric: 'PRIVATE', aircon: { power: '0', current_temperature: '26', token: 'PRIVATE' } } });
  assert.equal(normalized.power, false); assert.equal(normalized.temperature, 26);
  assert.ok(!JSON.stringify(normalized).includes('PRIVATE'));
  assert.throws(() => normalizeStatus({ data: { aircon: { power: 'unknown' } } }));
});
test('return URL parsing accepts only one credential on exact HTTPS Daikin origins', () => {
  assert.equal(parseAirconCredential(TOKEN), TOKEN);
  assert.equal(parseAirconCredential(`https://cmsntu-prod.daikinpayu.com/return?token=${TOKEN}`), TOKEN);
  assert.equal(parseAirconCredential(`https://apintu-prod.daikinpayu.com/return#access_token=${TOKEN}`), TOKEN);
  for (const invalid of [
    `https://loginfs.ntu.edu.sg/adfs/ls?token=${TOKEN}`,
    `https://cmsntu-prod.daikinpayu.com.attacker.example/?token=${TOKEN}`,
    `http://cmsntu-prod.daikinpayu.com/?token=${TOKEN}`,
    `https://cmsntu-prod.daikinpayu.com:444/?token=${TOKEN}`,
    `https://attacker@cmsntu-prod.daikinpayu.com/?token=${TOKEN}`,
    `https://cmsntu-prod.daikinpayu.com/?token=${TOKEN}&token=${TOKEN}`,
    `https://cmsntu-prod.daikinpayu.com/?token=${TOKEN}#access_token=${TOKEN}`,
    'https://cmsntu-prod.daikinpayu.com/?code=PRIVATE',
  ]) assert.throws(() => parseAirconCredential(invalid));
});
test('login return path is parsed only on the exact Daikin CMS origin', () => {
  assert.equal(parseLoginReturn(`https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/${TOKEN}`), TOKEN);
  assert.equal(parseLoginReturn(TOKEN), null);
  for (const value of [
    `https://attacker.example/adfs/saml/redirect/${TOKEN}`,
    `http://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/${TOKEN}`,
    `https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/${TOKEN}?extra=1`,
    'https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/%zz',
    'https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/',
  ]) assert.throws(() => parseLoginReturn(value));
});
test('login exchange posts the code as hash without a bearer header and validates the returned token', async () => {
  const client = createDaikinClient(async (url, init) => {
    assert.equal(url, 'https://apintu-prod.daikinpayu.com/auth/ad/callback');
    assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.body.get('hash'), 'fake-login-code-0123456789');
    return Response.json({ meta: { status: 200 }, data: { token: TOKEN } });
  });
  assert.equal(await client.exchange('fake-login-code-0123456789'), TOKEN);
  const broken = createDaikinClient(async () => Response.json({ meta: { status: 200 }, data: { token: 'invalid' } }));
  await assert.rejects(broken.exchange('fake-login-code-0123456789'));
});
test('pasted login return completes exchange and status validation before enabling control', async t => {
  let exchanged = false;
  const f = await fixture(t, { client: {
    exchange: async hash => { assert.equal(hash, 'fake-login-code-0123456789'); exchanged = true; return TOKEN; },
    status: async token => { assert.ok(exchanged); assert.equal(token, TOKEN); return { power: false, temperature: 25 }; },
    control: async () => assert.fail('No power command during sign-in'),
  } });
  await f.request('/api/session');
  const result = await f.request('/api/connect', { token: 'https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/fake-login-code-0123456789' });
  assert.equal(result.code, 200); assert.equal(result.value.connected, true);
  assert.ok(!JSON.stringify(result.value).includes(TOKEN));
  assert.ok(!JSON.stringify(result.value).includes('fake-login-code'));
});
test('power command waits for an asynchronous controller before reporting confirmation', async t => {
  let statusCalls = 0, sent = false;
  const f = await fixture(t, { client: {
    status: async () => ({ power: !sent || ++statusCalls < 3, temperature: 25 }),
    control: async () => { sent = true; },
  } });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  const result = await f.request('/api/power', { power: false });
  assert.equal(result.value.status.power, false); assert.equal(result.value.lastResult.confirmed, true);
  assert.equal(statusCalls, 3);
});
test('Daikin adapter uses fixed HTTPS endpoints, bearer auth and explicit power', async () => {
  const calls = [];
  const client = createDaikinClient(async (url, init) => {
    calls.push({ url, init });
    return Response.json(init.method === 'GET' ? { data: { aircon: { power: 0, current_temperature: 25 } } } : { success: true });
  });
  await client.status(TOKEN); await client.control(TOKEN, false);
  assert.equal(calls[0].url, 'https://apintu-prod.daikinpayu.com/me');
  assert.equal(calls[1].url, 'https://apintu-prod.daikinpayu.com/v2/ac/control');
  assert.equal(calls[1].init.body.toString(), 'power=0');
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[1].init.redirect, 'error');
});
test('upstream errors are sanitized and rejected tokens do not authenticate', async t => {
  for (const [code, expected] of [[401, 401], [402, 401], [403, 401], [500, 502]]) {
    const client = createDaikinClient(async () => new Response('PRIVATE upstream content', { status: code }));
    await assert.rejects(client.status(TOKEN), error => error.status === expected && !error.message.includes('PRIVATE'));
  }
  const f = await fixture(t, { client: createDaikinClient(async () => new Response('', { status: 401 })) });
  await f.request('/api/session');
  assert.equal((await f.request('/api/connect', { token: TOKEN })).code, 401);
  assert.equal((await f.request('/api/state')).value.connected, false);
});
test('local security rejects CSRF, foreign origins, Host spoofing, query secrets and unauthenticated writes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/power', { power: true })).code, 401);
  const session = await f.request('/api/session');
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(session.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await f.request('/api/practice', {}, { 'X-CSRF-Token': 'wrong' })).code, 403);
  assert.equal((await f.request('/api/practice', {}, { Origin: 'https://attacker.example' })).code, 403);
  assert.equal((await f.request('/api/practice', {}, { Host: 'attacker.example' })).code, 403);
  assert.equal((await f.request('/api/session?token=PRIVATE')).code, 400);
  assert.equal((await f.request('/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).code, 403);
  assert.deepEqual(f.commands, []);
});
test('live pairing checks status first; power and scheduled off reach authenticated transport', async t => {
  const f = await fixture(t); await f.request('/api/session');
  const connected = await f.request('/api/connect', { token: TOKEN });
  assert.equal(connected.code, 200); assert.equal(connected.value.mode, 'live');
  assert.ok(!JSON.stringify(connected.value).includes(TOKEN));
  assert.deepEqual(f.commands, []);
  assert.equal((await f.request('/api/power', { power: true })).value.status.power, true);
  await f.request('/api/timer', { minutes: 1 });
  f.advance(59999); await f.app.tick(); assert.deepEqual(f.commands, [true]);
  f.advance(1); await f.app.tick();
  const result = (await f.request('/api/state')).value;
  assert.equal(result.status.power, false); assert.equal(result.timer.state, 'completed');
  await f.app.tick(); assert.deepEqual(f.commands, [true, false]);
});
test('practice is isolated from Daikin, cancellation and disconnect stop pending jobs', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/practice', {});
  await f.request('/api/power', { power: true }); await f.request('/api/timer', { minutes: 1 });
  await f.request('/api/timer', { cancel: true }); f.advance(61000); await f.app.tick();
  assert.equal((await f.request('/api/state')).value.status.power, true);
  await f.request('/api/timer', { minutes: 1 });
  assert.equal((await f.request('/api/disconnect', {})).code, 409);
  await f.request('/api/disconnect', { confirm: true });
  f.advance(61000); await f.app.tick();
  assert.equal((await f.request('/api/state')).value.connected, false); assert.deepEqual(f.commands, []);
});
test('shutdown retries are bounded; turning on preserves schedules', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/timer', { minutes: 1 });
  await f.request('/api/power', { power: true });
  assert.equal((await f.request('/api/state')).value.timer.state, 'scheduled');
  await f.request('/api/timer', { minutes: 1 });
  f.fail(new Error('PRIVATE'));
  f.advance(60000); await f.app.tick();
  f.advance(15000); await f.app.tick(); f.advance(15000); await f.app.tick();
  assert.equal((await f.request('/api/state')).value.timer.state, 'failed');
  await f.app.tick(); assert.equal(f.commands.length, 4);
  assert.ok(!JSON.stringify((await f.request('/api/state')).value).includes('PRIVATE'));
});
test('expired sessions cannot issue controls and do not execute stale timers', async t => {
  const f = await fixture(t, { sessionMs: 120000 });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/timer', { minutes: 1 }); f.advance(120001); await f.app.tick();
  assert.equal((await f.request('/api/state')).code, 401); assert.deepEqual(f.commands, []);
});
test('busy sessions reject concurrent cancellation rather than silently losing it', async t => {
  let release;
  const client = { status: async () => ({ power: true, temperature: 25 }), control: async () => new Promise(resolve => { release = resolve; }) };
  const f = await fixture(t, { client }); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/timer', { minutes: 1 }); f.advance(60000);
  const ticking = f.app.tick();
  assert.equal((await f.request('/api/timer', { cancel: true })).code, 409);
  release(); await ticking;
  assert.equal((await f.request('/api/timer', { cancel: true })).code, 200);
  assert.equal((await f.request('/api/state')).value.timer.state, 'cancelled');
});
test('static interface and assets are served with a restrictive content policy', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/app.js', '/style.css', '/favicon.svg', '/apple-touch-icon.png']) {
    const response = await f.request(path);
    assert.equal(response.code, 200); assert.ok(response.value.length > 50);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  }
  assert.equal((await f.request('/server.mjs')).code, 404);
  assert.equal((await f.request('/../package.json')).code, 404);
});
test('unconfirmed power change does not report a successful shutdown', async t => {
  const f = await fixture(t, { client: { status: async () => ({ power: true, temperature: 25 }), control: async () => {} } });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  const result = await f.request('/api/power', { power: false });
  assert.equal(result.value.lastResult.confirmed, false);
  await f.request('/api/timer', { minutes: 1 });
  f.advance(60000); await f.app.tick();
  f.advance(15000); await f.app.tick(); f.advance(15000); await f.app.tick();
  assert.equal((await f.request('/api/state')).value.timer.state, 'failed');
});
test('expired upstream token stops shutdown retries and disables controls', async t => {
  let expired = false, attempts = 0;
  const client = { status: async () => ({ power: true, temperature: 25 }), control: async () => {
    attempts++; if (expired) { const error = new Error('Expired'); error.status = 401; throw error; }
  } };
  const f = await fixture(t, { client });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/timer', { minutes: 1 }); expired = true;
  f.advance(60000); await f.app.tick(); f.advance(15000); await f.app.tick();
  const state = (await f.request('/api/state')).value;
  assert.equal(state.connected, false); assert.equal(state.timer.state, 'failed'); assert.equal(attempts, 1);
  assert.equal((await f.request('/api/power', { power: true })).code, 401);
});
test('cloud transport reports safe step and timeout diagnostics and never follows redirects', async () => {
  const client = createDaikinClient(async () => { const error = new Error('private credential'); error.name = 'TimeoutError'; throw error; }, { cloud: true });
  await assert.rejects(() => client.exchange(TOKEN), /login exchange \(timed out\)/);
  await assert.rejects(() => client.status(TOKEN), /status check \(timed out\)/);
  const redirectClient = createDaikinClient(async (_url, init) => {
    assert.equal(init.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://other.example' } });
  }, { cloud: true });
  await assert.rejects(() => redirectClient.status(TOKEN), /No redirect was followed/);
});


test('absolute shutdowns are validated against server time; invalid replacement preserves the job', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/practice', {});
  const now = (await f.request('/api/state')).value.serverNow;
  const dueAt = now + 12 * 3600000;
  const scheduled = await f.request('/api/timer', { dueAt });
  assert.equal(scheduled.code, 200); assert.equal(scheduled.value.timer.dueAt, dueAt);
  for (const payload of [{ dueAt: now }, { dueAt: now - 1 }, { dueAt: dueAt + 86400000 }, { dueAt: 'tomorrow' }, { dueAt, minutes: 1 }, {}, { minutes: 1441 }]) {
    assert.equal((await f.request('/api/timer', payload)).code, 400);
    assert.deepEqual((await f.request('/api/state')).value.timer, scheduled.value.timer);
  }
  assert.equal((await f.request('/api/timer', { minutes: 1440 })).code, 200);
});
test('manual confirmed off resolves shutdown; unconfirmed and failed off preserve it', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/timer', { minutes: 1 }); f.fail(new Error('private'));
  assert.equal((await f.request('/api/power', { power: false })).code, 500);
  assert.equal((await f.request('/api/state')).value.timer.state, 'scheduled');
  f.fail(null); await f.request('/api/power', { power: false });
  assert.equal((await f.request('/api/state')).value.timer.completedBy, 'manual');
  const unconfirmed = await fixture(t, { client: { status: async () => ({ power: true }), control: async () => {} } });
  await unconfirmed.request('/api/session'); await unconfirmed.request('/api/connect', { token: TOKEN });
  await unconfirmed.request('/api/timer', { minutes: 1 }); await unconfirmed.request('/api/power', { power: false });
  assert.equal((await unconfirmed.request('/api/state')).value.timer.state, 'scheduled');
});
test('token expiry during status retains failed outcome and reconnect never resurrects the failed job', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/timer', { minutes: 1 });
  const expired = new Error('private'); expired.status = 401; f.fail(expired);
  assert.equal((await f.request('/api/status', {})).code, 500);
  const state = (await f.request('/api/state')).value;
  assert.equal(state.connected, false); assert.equal(state.timer.state, 'failed');
  f.fail(null); await f.request('/api/connect', { token: TOKEN });
  assert.equal((await f.request('/api/state')).value.timer.state, 'failed');
  f.advance(60000); await f.app.tick(); assert.deepEqual(f.commands, []);
});
test('schedule commit failure restores the previous accepted schedule', async t => {
  let fail = false; let records;
  const f = await fixture(t, { vault: { save: async value => { if (fail) throw new Error('private'); records = structuredClone(value); } } });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  const old = (await f.request('/api/timer', { minutes: 1 })).value.timer;
  fail = true; assert.equal((await f.request('/api/timer', { minutes: 10 })).code, 503);
  assert.deepEqual((await f.request('/api/state')).value.timer, old); assert.deepEqual(records[0].timer, old);
  fail = false; f.advance(60000); await f.app.tick(); assert.deepEqual(f.commands, [false]);
});

test('failed shutdown reason survives subsequent successful controls', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/timer', { minutes: 1 }); f.advance(180001); await f.app.tick();
  const failed = (await f.request('/api/state')).value.timer;
  assert.equal(failed.state, 'failed'); assert.match(failed.error, /missed/);
  await f.request('/api/power', { power: true });
  assert.equal((await f.request('/api/state')).value.timer.error, failed.error);
});

test('repeated failed commits cannot mutate the accepted rollback snapshot', async t => {
  let fail = false;
  const f = await fixture(t, { vault: { save: async () => { if (fail) throw new Error('private'); } } });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  const accepted = (await f.request('/api/timer', { minutes: 1 })).value.timer;
  fail = true; await f.request('/api/timer', { minutes: 10 });
  f.advance(60000); await assert.rejects(f.app.tick(), /save/);
  assert.deepEqual((await f.request('/api/state')).value.timer, accepted);
  await assert.rejects(f.app.tick(), /save/);
  assert.deepEqual((await f.request('/api/state')).value.timer, accepted);
  fail = false; await f.app.tick();
  assert.equal((await f.request('/api/state')).value.timer.state, 'completed');
});
test('status keeps balance and fan but still no identity', () => {
  const normalized = normalizeStatus({ data: { firstname: 'PRIVATE', email: 'PRIVATE', balance: 4.76, aircon: { power: 1, current_temperature: 25, setpoint: 22, fanstep: 'H', aircon_code: 'PRIVATE' } } });
  assert.equal(normalized.balance, 4.76); assert.equal(normalized.fan, 'H');
  assert.ok(!JSON.stringify(normalized).includes('PRIVATE'));
});
const saverSettings = (onMinutes, offMinutes, extra = {}) => ({ settings: { kind: 'interval', firstMinutes: onMinutes, onMinutes, offMinutes, coolTo: 24, warmTo: 26, ...extra } });
test('Saver is on by default: Turn on cools in cycles, logs every switch, and Turn off ends it', async t => {
  const f = await fixture(t); await f.request('/api/session');
  const connected = (await f.request('/api/connect', { token: TOKEN })).value;
  assert.equal(connected.saverConfig.enabled, true); assert.equal(connected.saver, null);
  assert.equal((await f.request('/api/saver', saverSettings(2, 5))).code, 400);
  assert.equal((await f.request('/api/saver', saverSettings(5, 3, { coolTo: 26 }))).code, 400);
  assert.equal((await f.request('/api/saver', {})).code, 400);
  assert.equal((await f.request('/api/saver', saverSettings(5, 3), { 'X-CSRF-Token': 'forged' })).code, 403);
  // Saving settings while the aircon is off never switches anything on.
  assert.equal((await f.request('/api/saver', saverSettings(5, 3))).value.saver, null); assert.deepEqual(f.commands, []);
  const started = (await f.request('/api/power', { power: true })).value;
  assert.equal(started.saver.state, 'running'); assert.equal(started.saver.onMinutes, 5); assert.deepEqual(f.commands, [true]);
  for (let minute = 0; minute < 4; minute++) { f.advance(60000); await f.app.tick(); }
  assert.deepEqual(f.commands, [true]);
  f.advance(60000); await f.app.tick(); assert.deepEqual(f.commands, [true, false]);
  assert.equal((await f.request('/api/state')).value.saver.phase, 'off');
  f.advance(179999); await f.app.tick(); assert.deepEqual(f.commands, [true, false]);
  f.advance(1); await f.app.tick(); assert.deepEqual(f.commands, [true, false, true]);
  const rows = (await f.request('/api/history', { hours: 1 })).value.history;
  assert.deepEqual(rows.filter(row => row.e).map(row => row.e), ['connect', 'manual-on', 'saver-start', 'saver-off', 'saver-on']);
  const stopped = (await f.request('/api/power', { power: false })).value;
  assert.equal(stopped.saver.state, 'stopped'); assert.equal(stopped.saver.reason, null); assert.equal(stopped.saverConfig.enabled, true);
  f.advance(600000); await f.app.tick(); assert.deepEqual(f.commands, [true, false, true, false]);
});
test('Saver switch: off keeps the aircon cooling (ending a rest), on starts cycling only if already on', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/saver', saverSettings(3, 10)); await f.request('/api/power', { power: true });
  f.advance(180000); await f.app.tick(); assert.deepEqual(f.commands, [true, false]);
  const off = (await f.request('/api/saver', { enabled: false })).value;
  assert.equal(off.saverConfig.enabled, false); assert.equal(off.saver.state, 'stopped'); assert.equal(off.status.power, true);
  f.advance(3600000); await f.app.tick(); assert.deepEqual(f.commands, [true, false, true]);
  // Disabled: Turn on runs nonstop.
  await f.request('/api/power', { power: false }); await f.request('/api/power', { power: true });
  assert.equal((await f.request('/api/state')).value.saver.state, 'stopped');
  const on = (await f.request('/api/saver', { enabled: true })).value;
  assert.equal(on.saver.state, 'running'); assert.equal(on.saver.phase, 'on');
  // New settings apply to the running cycle without restarting it.
  const changed = (await f.request('/api/saver', saverSettings(20, 4))).value;
  assert.equal(changed.saver.onMinutes, 20); assert.equal(changed.saver.id, on.saver.id);
  await f.request('/api/power', { power: false }); const count = f.commands.length;
  assert.equal((await f.request('/api/saver', { enabled: false })).value.saver.state, 'stopped');
  assert.equal((await f.request('/api/saver', { enabled: true })).value.saver.state, 'stopped'); assert.equal(f.commands.length, count);
});
test('temperature Saver waits for the room reading and respects minimum phase times', async t => {
  let room = 27, power = false; const commands = [];
  const client = { status: async () => ({ power, temperature: room, setpoint: 22, balance: 5, checkedAt: 0 }), control: async (_token, next) => { commands.push(next); power = next; } };
  const f = await fixture(t, { client }); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/saver', saverSettings(3, 3, { kind: 'thermostat' })); await f.request('/api/power', { power: true });
  room = 24; f.advance(120000); await f.app.tick(); assert.deepEqual(commands, [true]);
  room = 25; f.advance(120000); await f.app.tick(); assert.deepEqual(commands, [true]);
  room = 24; f.advance(60000); await f.app.tick(); assert.deepEqual(commands, [true, false]);
  room = 26; f.advance(60000); await f.app.tick(); assert.deepEqual(commands, [true, false]);
  f.advance(120000); await f.app.tick(); assert.deepEqual(commands, [true, false, true]);
});
test('Saver never fights an off made elsewhere, stops with the shutdown timer and on expired sign-in', async t => {
  let power = false; let reject = false; const commands = [];
  const client = { status: async () => { if (reject) throw Object.assign(new Error('expired'), { status: 401 }); return { power, temperature: 25, setpoint: 22, balance: 5, checkedAt: 0 }; }, control: async (_token, next) => { commands.push(next); power = next; } };
  const f = await fixture(t, { client }); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/saver', saverSettings(5, 5)); await f.request('/api/power', { power: true });
  power = false; f.advance(60000); await f.app.tick();
  let state = (await f.request('/api/state')).value;
  assert.equal(state.saver.state, 'stopped'); assert.match(state.saver.reason, /elsewhere/); assert.deepEqual(commands, [true]);
  await f.request('/api/power', { power: true }); await f.request('/api/timer', { minutes: 2 });
  f.advance(120000); await f.app.tick();
  state = (await f.request('/api/state')).value;
  assert.equal(state.timer.state, 'completed'); assert.equal(state.saver.state, 'stopped'); assert.equal(power, false);
  f.advance(3600000); await f.app.tick(); assert.deepEqual(commands, [true, true, false]);
  await f.request('/api/power', { power: true });
  reject = true; f.advance(60000); await f.app.tick();
  state = (await f.request('/api/state')).value;
  assert.equal(state.connected, false); assert.equal(state.saver.state, 'stopped');
});
test('Saver retries an unconfirmed switch-off and gives up after five tries', async t => {
  let power = false; let stuck = false; const commands = [];
  const client = { status: async () => ({ power, temperature: 25, setpoint: 22, balance: 5, checkedAt: 0 }), control: async (_token, next) => { commands.push(next); if (!stuck) power = next; } };
  const f = await fixture(t, { client }); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/saver', saverSettings(3, 3)); await f.request('/api/power', { power: true });
  stuck = true; f.advance(180000);
  for (let i = 0; i < 8; i++) { await f.app.tick(); f.advance(20000); }
  const state = (await f.request('/api/state')).value;
  assert.equal(state.saver.state, 'stopped'); assert.match(state.saver.reason, /five tries/);
  assert.equal(commands.filter(command => command === false).length, 5);
});
test('remembered Saver, its settings and next wake-up survive a restart', async t => {
  let saved = [];
  const vault = { save: async records => { saved = structuredClone(records); } };
  const f = await fixture(t, { vault }); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/saver', saverSettings(5, 7)); await f.request('/api/power', { power: true });
  assert.equal(saved[0].saver.state, 'running'); assert.equal(saved[0].saverConfig.offMinutes, 7); assert.ok(saved[0].nextPoll > 1700000000000);
  let power = true; const commands = [];
  const client = { status: async () => ({ power, temperature: 25, setpoint: 22, balance: 5, checkedAt: 0 }), control: async (_token, next) => { commands.push(next); power = next; } };
  let clock = 1700000000000 + 300000;
  const restarted = createApp({ client, now: () => clock, pause: async () => {}, vault, initialRecords: saved });
  t.after(() => restarted.close());
  await restarted.tick(); assert.deepEqual(commands, [false]);
});
test('Saver cools longer first, then holds with the short cycle; defaults are 10 then 5 on, 5 rest', async t => {
  const f = await fixture(t); await f.request('/api/session');
  const config = (await f.request('/api/connect', { token: TOKEN })).value.saverConfig;
  assert.deepEqual([config.firstMinutes, config.onMinutes, config.offMinutes], [10, 5, 5]);
  assert.equal((await f.request('/api/saver', saverSettings(5, 5, { firstMinutes: 1 }))).code, 400);
  await f.request('/api/power', { power: true });
  f.advance(599999); await f.app.tick(); assert.deepEqual(f.commands, [true]);
  f.advance(1); await f.app.tick(); assert.deepEqual(f.commands, [true, false]);
  f.advance(300000); await f.app.tick(); assert.deepEqual(f.commands, [true, false, true]);
  f.advance(299999); await f.app.tick(); assert.deepEqual(f.commands, [true, false, true]);
  f.advance(1); await f.app.tick(); assert.deepEqual(f.commands, [true, false, true, false]);
});
test('day totals are kept from every reading, rebuilt once from earlier raw rows, and returned for any range', async t => {
  const history = (await import('../server.mjs')).memoryHistory();
  const start = Date.parse('2026-10-13T23:50:00+08:00');
  // Readings logged before day totals existed.
  await history.append({ t: start - 120000, p: 1, r: 25, s: 22, b: 5 }); await history.append({ t: start - 60000, p: 1, r: 25, s: 22, b: 5 });
  let power = true, balance = 5, clock = start;
  const client = { status: async () => ({ power, temperature: 24, setpoint: 22, balance, checkedAt: 0 }), control: async (_token, next) => { if (power && !next) balance = 4.9; power = next; } };
  const f = await fixture(t, { client, history, now: () => clock });
  await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN }); await f.request('/api/saver', { enabled: false });
  for (let minute = 0; minute < 20; minute++) { clock += 60000; await f.app.tick(); }
  await f.request('/api/power', { power: false });
  const days = (await f.request('/api/usage', {})).value.usage;
  assert.deepEqual(days.map(day => day.date), ['2026-10-13', '2026-10-14']);
  assert.equal(days[0].onMs, 12 * 60000); assert.equal(days[1].onMs, 10 * 60000);
  assert.equal(days[0].charged, 0); assert.equal(days[1].charged, 0.1);
  assert.deepEqual(await history.months(), ['2026-10']);
});
test('an aircon found running without Saver starts cycling at the next reading, unless Saver is off or gave up', async t => {
  let power = true, stuck = false; const commands = [];
  const client = { status: async () => ({ power, temperature: 25, setpoint: 22, balance: 5, checkedAt: 0 }), control: async (_token, next) => { commands.push(next); if (!stuck) power = next; } };
  const f = await fixture(t, { client }); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  assert.equal((await f.request('/api/state')).value.saver, null);
  f.advance(60000); await f.app.tick();
  let state = (await f.request('/api/state')).value;
  assert.equal(state.saver.state, 'running'); assert.deepEqual(commands, []);
  f.advance(600000); await f.app.tick(); assert.deepEqual(commands, [false]);
  // Switched on again from the official app during a rest: adopted, not restarted.
  power = true; f.advance(60000); await f.app.tick();
  assert.equal((await f.request('/api/state')).value.saver.phase, 'on');
  // After giving up on unconfirmed commands, Saver does not restart itself.
  stuck = true; f.advance(300000);
  for (let i = 0; i < 8; i++) { await f.app.tick(); f.advance(20000); }
  state = (await f.request('/api/state')).value;
  assert.equal(state.saver.blocked, true); const count = commands.length;
  f.advance(3600000); await f.app.tick(); assert.equal(commands.length, count);
  // Switched off in settings: a running aircon is left alone.
  stuck = false; await f.request('/api/saver', { enabled: false }); await f.request('/api/power', { power: true });
  f.advance(3600000); await f.app.tick(); assert.equal((await f.request('/api/state')).value.saver.state, 'stopped');
});

test('a shutdown during a Saver rest succeeds even if Daikin refuses the redundant off', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/saver', saverSettings(3, 10)); await f.request('/api/power', { power: true });
  for (let minute = 0; minute < 3; minute++) { f.advance(60000); await f.app.tick(); }
  assert.equal((await f.request('/api/state')).value.saver.phase, 'off'); assert.deepEqual(f.commands, [true, false]);
  await f.request('/api/timer', { minutes: 1 });
  const control = f.client.control;
  f.client.control = async () => { throw new AppError(502, 'Daikin did not accept the request.'); };
  f.advance(60000); await f.app.tick();
  const state = (await f.request('/api/state')).value;
  assert.equal(state.timer.state, 'completed'); assert.equal(state.saver.state, 'stopped');
  f.client.control = control;
  for (let minute = 0; minute < 15; minute++) { f.advance(60000); await f.app.tick(); }
  assert.deepEqual(f.commands, [true, false]);
});

test('a failed shutdown still ends Saver so it never turns the aircon back on', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/saver', saverSettings(3, 10)); await f.request('/api/power', { power: true });
  for (let minute = 0; minute < 3; minute++) { f.advance(60000); await f.app.tick(); }
  await f.request('/api/timer', { minutes: 1 });
  f.fail(new Error('offline'));
  f.advance(60000); await f.app.tick(); f.advance(15000); await f.app.tick(); f.advance(15000); await f.app.tick();
  f.fail(null);
  const state = (await f.request('/api/state')).value;
  assert.equal(state.timer.state, 'failed'); assert.equal(state.saver.state, 'stopped');
  for (let minute = 0; minute < 15; minute++) { f.advance(60000); await f.app.tick(); }
  assert.equal(f.commands.filter(c => c === true).length, 1);
});

test('a slow first shutdown attempt is still retried after the two-minute window', async t => {
  const f = await fixture(t); await f.request('/api/session'); await f.request('/api/connect', { token: TOKEN });
  await f.request('/api/saver', { enabled: false }); await f.request('/api/power', { power: true });
  await f.request('/api/timer', { minutes: 1 });
  f.fail(new Error('offline')); f.advance(60000); await f.app.tick();
  f.fail(null); f.advance(150000); await f.app.tick();
  assert.equal((await f.request('/api/state')).value.timer.state, 'completed'); assert.equal(f.commands.at(-1), false);
});
