import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Aircon } from '../cloudflare/worker.mjs';

const env = { ACCESS_PASSWORD: 'private-test-password-0123456789', ENCRYPTION_KEY: 'ab'.repeat(32) };
const origin = 'https://better-hall-aircon.example.workers.dev';
function storage() {
  const data = new Map(); let alarm = null;
  const api = { get: async k => data.get(k), put: async (k,v) => data.set(k,v),
    setAlarm: async t => { alarm = t; }, deleteAlarm: async () => { alarm = null; },
    transaction: async fn => fn(api) };
  return { api, data, alarm: () => alarm };
}
test('public entry fails closed without secrets and requires private access before serving assets', async () => {
  assert.equal((await worker.fetch(new Request(origin), {})).status, 503);
  assert.equal((await worker.fetch(new Request(origin), env)).status, 401);
  let served = false;
  const response = await worker.fetch(new Request(origin, { headers: { authorization: 'Basic ' + Buffer.from('owner:' + env.ACCESS_PASSWORD).toString('base64') } }), {
    ...env, ASSETS: { fetch: async () => { served = true; return new Response('Keep this computer awake and the local server running. Closing this tab is fine.'); } },
  });
  assert.equal(response.status, 200); assert.equal(served, true);
  assert.match(await response.text(), /computer off/);
});
test('cloud sessions and CSRF survive object eviction, encrypted timers run through alarm, cancellation removes due alarm', async () => {
  const store = storage(); let object = new Aircon({ storage: store.api }, env);
  let cookie = '', csrf = '';
  async function request(path, body, csrfOverride = csrf) {
    const response = await object.fetch(new Request(origin + path, { method: body ? 'POST' : 'GET',
      headers: { cookie, ...(body ? { origin, 'content-type': 'application/json', 'x-csrf-token': csrfOverride } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const setCookie = response.headers.get('set-cookie'); if (setCookie) { assert.match(setCookie, /; Secure/); cookie = setCookie.split(';')[0]; }
    const value = await response.json(); if (value.csrf) csrf = value.csrf;
    return { response, value };
  }
  await request('/api/session'); const oldCsrf = csrf;
  object = new Aircon({ storage: store.api }, env);
  assert.equal((await request('/api/session')).value.csrf, oldCsrf);
  assert.equal((await request('/api/practice', {}, 'forged')).response.status, 403);
  await request('/api/practice', {}); await request('/api/power', { power: true });
  const scheduled = await request('/api/timer', { minutes: 1 });
  assert.equal(store.alarm(), scheduled.value.timer.dueAt);
  assert.ok(!Buffer.from(store.data.get('connections')).toString().includes(oldCsrf));
  object = new Aircon({ storage: store.api }, env);
  await request('/api/session'); await request('/api/timer', { cancel: true });
  assert.ok(store.alarm() > scheduled.value.timer.dueAt);
  await request('/api/timer', { minutes: 1 });
  const realNow = Date.now; const due = store.alarm();
  try {
    Date.now = () => due + 1;
    object = new Aircon({ storage: store.api }, env); await object.alarm();
    const state = (await request('/api/state')).value;
    assert.equal(state.timer.state, 'completed'); assert.equal(state.status.power, false);
  } finally { Date.now = realNow; }
});
