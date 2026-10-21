import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Aircon } from '../cloudflare/worker.mjs';
import { ROOM_ID } from '../server.mjs';

const env = { ACCESS_PASSWORD: 'private-test-password-0123456789', ENCRYPTION_KEY: 'ab'.repeat(32) };
const origin = 'https://better-hall-aircon.example.workers.dev';
function storage() {
  let data = new Map(); let alarm = null; let fail = null;
  const api = { get: async k => Array.isArray(k) ? new Map(k.filter(key => data.has(key)).map(key => [key, structuredClone(data.get(key))])) : structuredClone(data.get(k)), put: async (k,v) => { if (fail === k) throw new Error('private storage error'); data.set(k, structuredClone(v)); },
    list: async ({ prefix }) => new Map([...data].filter(([key]) => key.startsWith(prefix)).sort()),
    setAlarm: async t => { if (fail === 'alarm') throw new Error('private alarm error'); alarm = t; }, deleteAlarm: async () => { alarm = null; },
    transaction: async fn => {
      const old = structuredClone(data); const oldAlarm = alarm;
      try { return await fn(api); } catch (error) { data = old; alarm = oldAlarm; throw error; }
    } };
  return { api, get data() { return data; }, alarm: () => alarm, fail: value => { fail = value; } };
}
function browser(objectProvider) {
  let cookie = '', csrf = '';
  async function request(path, body, overrides = {}) {
    const response = await objectProvider().fetch(new Request(origin + path, { method: body !== undefined ? 'POST' : 'GET',
      headers: { cookie, ...(body !== undefined ? { origin, 'content-type': 'application/json', 'x-csrf-token': csrf } : {}), ...overrides },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
    const setCookie = response.headers.get('set-cookie'); if (setCookie) { assert.match(setCookie, /; Secure/); cookie = setCookie.split(';')[0]; }
    const value = await response.json(); if (value.csrf) csrf = value.csrf;
    return { response, value };
  }
  return { request, login: async remember => { const result = await request('/api/access/login', { password: env.ACCESS_PASSWORD, remember }); assert.equal(result.response.status, 200); await request('/api/session'); return result; }, get cookie() { return cookie; }, get csrf() { return csrf; } };
}
async function seal(store, value) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(env.ENCRYPTION_KEY, 'hex'), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('hall-aircon-cloud-v1') }, key, new TextEncoder().encode(JSON.stringify(value))));
  await store.api.put('connections', new Uint8Array(Buffer.concat([iv, ciphertext.subarray(-16), ciphertext.subarray(0,-16)])));
}

test('public shell never prompts for Basic auth; missing secrets fail closed and all API access goes to the object', async () => {
  assert.equal((await worker.fetch(new Request(origin), {})).status, 503);
  const object = new Aircon({ storage: storage().api }, env);
  const runtime = { ...env, ASSETS: { fetch: async () => new Response('<html>public shell</html>') }, AIRCON: { idFromName: () => 'personal', get: () => object } };
  const shell = await worker.fetch(new Request(origin), runtime);
  assert.equal(shell.status, 200); assert.equal(shell.headers.get('www-authenticate'), null);
  assert.equal((await worker.fetch(new Request(origin + '/api/state'), runtime)).status, 401);
  assert.equal((await worker.fetch(new Request(origin.replace('https:', 'http:')), runtime)).status, 403);
});
test('remembered devices share one encrypted room and timer after eviction; alarms run after logout', async () => {
  const store = storage(); let object = new Aircon({ storage: store.api }, env);
  const a = browser(() => object), b = browser(() => object);
  assert.equal((await a.request('/api/session')).value.authenticated, false);
  const login = await a.login(); assert.match(login.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000/);
  // Saver off here so the shutdown is the only pending wake-up.
  await a.request('/api/practice', {}); await a.request('/api/saver', { enabled: false }); await a.request('/api/power', { power: true });
  const scheduled = (await a.request('/api/timer', { minutes: 1 })).value.timer;
  assert.equal(store.alarm(), scheduled.dueAt);
  assert.ok(!Buffer.from(store.data.get('connections')).toString().includes(a.csrf));
  object = new Aircon({ storage: store.api }, env);
  assert.equal((await a.request('/api/session')).value.timer.id, scheduled.id);
  await b.login(); assert.equal((await b.request('/api/state')).value.timer.id, scheduled.id);
  assert.equal((await b.request('/api/timer', { cancel: true }, { 'x-csrf-token': a.csrf })).response.status, 403);
  await a.request('/api/access/logout', {});
  assert.equal((await a.request('/api/state')).response.status, 401);
  assert.equal((await b.request('/api/state')).value.timer.state, 'scheduled');
  const realNow = Date.now;
  try {
    Date.now = () => scheduled.dueAt + 1; object = new Aircon({ storage: store.api }, env); await object.alarm();
    const state = (await b.request('/api/state')).value;
    assert.equal(state.timer.state, 'completed'); assert.equal(state.status.power, false);
    await object.alarm(); assert.equal((await b.request('/api/state')).value.timer.attempts, 1);
  } finally { Date.now = realNow; }
});
test('device expiry and revoke-all leave a room shutdown running; password rotation invalidates access', async () => {
  const store = storage(); let object = new Aircon({ storage: store.api }, env);
  const a = browser(() => object), b = browser(() => object); await a.login(false); await b.login();
  await a.request('/api/practice', {}); const now = Date.now();
  const job = (await a.request('/api/timer', { dueAt: now + 13 * 3600000 })).value.timer;
  const realNow = Date.now;
  try {
    Date.now = () => now + 12 * 3600000 + 1; object = new Aircon({ storage: store.api }, env); await object.alarm();
    assert.equal((await a.request('/api/state')).response.status, 401);
    assert.equal((await b.request('/api/state')).value.timer.id, job.id);
    await b.request('/api/access/revoke', {}); assert.equal((await b.request('/api/state')).response.status, 401);
    Date.now = () => job.dueAt + 1; object = new Aircon({ storage: store.api }, env); await object.alarm();
    await b.login(); assert.equal((await b.request('/api/state')).value.timer.state, 'completed');
    object = new Aircon({ storage: store.api }, { ...env, ACCESS_PASSWORD: 'different-private-password-0123456789' });
    assert.equal((await b.request('/api/state')).response.status, 401);
  } finally { Date.now = realNow; }
});
test('remembered devices renew on use so the 30 days count from last visit; session-only logins do not', async () => {
  const store = storage(); const object = new Aircon({ storage: store.api }, env);
  const a = browser(() => object), b = browser(() => object); await a.login(); await b.login(false);
  const realNow = Date.now, start = Date.now();
  try {
    Date.now = () => start + 3600000; assert.equal((await a.request('/api/session')).response.headers.get('set-cookie'), null);
    for (const day of [20, 40, 60]) {
      Date.now = () => start + day * 86400000;
      const renewed = await a.request('/api/session');
      assert.equal(renewed.value.authenticated, true); assert.match(renewed.response.headers.get('set-cookie'), /SameSite=Lax; Path=\/; Max-Age=2592000/);
    }
    Date.now = () => start + 91 * 86400000; assert.equal((await a.request('/api/session')).value.authenticated, false);
    Date.now = () => start + 13 * 3600000; assert.equal((await b.request('/api/session')).value.authenticated, false);
  } finally { Date.now = realNow; }
});
test('password login is origin checked, durably rate limited, bounded and never grants access through Basic auth', async () => {
  const store = storage(); let object = new Aircon({ storage: store.api }, env); const a = browser(() => object);
  assert.equal((await a.request('/api/access/login', { password: env.ACCESS_PASSWORD }, { origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await a.request('/api/state', undefined, { authorization: 'Basic ' + Buffer.from('owner:' + env.ACCESS_PASSWORD).toString('base64') })).response.status, 401);
  for (let i = 0; i < 6; i++) { assert.equal((await a.request('/api/access/login', { password: 'wrong' })).response.status, 401); object = new Aircon({ storage: store.api }, env); }
  assert.equal((await a.request('/api/access/login', { password: env.ACCESS_PASSWORD })).response.status, 429);
  assert.equal((await a.request('/api/access/login', { password: 'x'.repeat(11000) })).response.status, 413);
});
test('atomic storage/alarm failure preserves the old accepted shutdown in memory and after eviction', async () => {
  const store = storage(); let object = new Aircon({ storage: store.api }, env); const a = browser(() => object); await a.login();
  await a.request('/api/practice', {}); const old = (await a.request('/api/timer', { minutes: 1 })).value.timer;
  for (const stage of ['connections', 'alarm']) {
    store.fail(stage); const result = await a.request('/api/timer', { minutes: 10 });
    assert.equal(result.response.status, 503); assert.doesNotMatch(JSON.stringify(result.value), /private storage|private alarm/);
    store.fail(null); assert.equal(store.alarm(), old.dueAt);
    assert.deepEqual((await a.request('/api/state')).value.timer, old);
    object = new Aircon({ storage: store.api }, env); assert.deepEqual((await a.request('/api/state')).value.timer, old);
  }
});
test('single legacy connection migrates with pending job; competing connections require an explicit choice', async () => {
  const now = Date.now();
  const legacy = id => ({ id, csrf: 'c'.repeat(43), mode: 'practice', token: null, remember: true, expiresAt: now + 60000,
    status: { power: true, checkedAt: now }, timer: { dueAt: now + 30000, nextAttempt: now + 30000, state: 'scheduled', attempts: 0 } });
  const store = storage(); await seal(store, [legacy('a'.repeat(43))]);
  let object = new Aircon({ storage: store.api }, env); const a = browser(() => object); await a.login();
  assert.equal((await a.request('/api/state')).value.timer.dueAt, now + 30000);
  const realNow = Date.now;
  try { Date.now = () => now + 60001; object = new Aircon({ storage: store.api }, env); assert.equal((await a.request('/api/state')).value.connected, true); }
  finally { Date.now = realNow; }
  const conflicted = storage(); await seal(conflicted, [legacy('a'.repeat(43)), legacy('b'.repeat(43))]);
  object = new Aircon({ storage: conflicted.api }, env); const b = browser(() => object); await b.login();
  const state = (await b.request('/api/session')).value;
  assert.equal(state.migration.length, 2); assert.doesNotMatch(JSON.stringify(state.migration), /token|csrf/);
  assert.equal((await b.request('/api/migration', { id: 'unknown' })).response.status, 400);
  const chosen = await b.request('/api/migration', { id: 'b'.repeat(43) }); assert.equal(chosen.value.timer.dueAt, now + 30000);
  assert.equal(object.data.rooms[0].id, ROOM_ID); assert.deepEqual(object.data.legacy, []);
});
test('cloud Saver wakes by alarm with no page open and stores readings by the hour', async () => {
  const store = storage(); let object = new Aircon({ storage: store.api }, env);
  const a = browser(() => object); await a.login();
  await a.request('/api/practice', {});
  await a.request('/api/saver', { settings: { kind: 'interval', firstMinutes: 3, onMinutes: 3, offMinutes: 3, coolTo: 24, warmTo: 26 } });
  const started = (await a.request('/api/power', { power: true })).value;
  assert.equal(started.saver.state, 'running'); assert.ok(store.alarm() <= started.saver.phaseStart + 180000);
  const realNow = Date.now;
  try {
    // A fresh object models eviction and picks up the patched clock.
    Date.now = () => started.saver.phaseStart + 180000; object = new Aircon({ storage: store.api }, env); await object.alarm();
    const rested = (await a.request('/api/state')).value;
    assert.equal(rested.saver.phase, 'off'); assert.equal(rested.status.power, false);
    assert.equal(store.alarm(), rested.saver.phaseStart + 60000);
  } finally { Date.now = realNow; }
  const history = object.history(); const stamp = Date.now();
  await history.putMonth('2026-10', { '2026-10-14': { date: '2026-10-14', onMs: 1 } });
  assert.deepEqual(await history.months(), ['2026-10']); assert.equal((await history.month('2026-10'))['2026-10-14'].onMs, 1);
  await history.append({ t: stamp - 7200000, p: 1, r: 25, s: 22, b: 5 }); await history.append({ t: stamp, p: 0, r: 26, s: 22, b: 4.9 });
  assert.equal((await history.read(stamp - 3600000)).length, 1); assert.equal((await history.read(stamp - 10800000)).length, 2);
});
