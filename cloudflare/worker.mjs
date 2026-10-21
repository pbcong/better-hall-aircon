import { createApp, createDaikinClient, ROOM_ID } from '../server.mjs';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const digest = value => createHash('sha256').update(value).digest('hex');
const matches = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra },
});
// Lax, not Strict: Safari withholds Strict cookies from a page opened via another site or app, which looked like a
// random logout. Writes stay protected by the Origin check, Sec-Fetch-Site and the per-device CSRF token.
const accessCookie = (value, maxAge) => `__Host-aircon_access=${value}; HttpOnly; Secure; SameSite=Lax; Path=/${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;
const expiredCookie = accessCookie('', 0);
const REMEMBER_MS = 30 * 86400000, SESSION_MS = 12 * 3600000;

export default {
  async fetch(request, env) {
    if (!env.ACCESS_PASSWORD || env.ACCESS_PASSWORD.length < 20 || !/^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY ?? '')) {
      return json({ error: 'Configure ACCESS_PASSWORD and ENCRYPTION_KEY first.' }, 503);
    }
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return json({ error: 'HTTPS required.' }, 403);
    if (url.pathname.startsWith('/api/')) {
      return env.AIRCON.get(env.AIRCON.idFromName('personal-aircon')).fetch(request);
    }
    if (request.method !== 'GET' || url.search || !['/', '/app.js', '/schedule.js', '/usage.js', '/style.css', '/favicon.svg', '/apple-touch-icon.png'].includes(url.pathname)) {
      return json({ error: 'Not found.' }, 404);
    }
    // Only the static shell is public. Every room read and command is authenticated in the object.
    const asset = await env.ASSETS.fetch(request);
    const responseHeaders = new Headers(asset.headers);
    for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value);
    return new Response(asset.body, { status: asset.status, headers: responseHeaders });
  },
};

// One owner room, durable device logins, and serialized commands/alarms.
export class Aircon {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  serial(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }
  async initialize(origin) {
    if (this.key) return;
    this.key = await crypto.subtle.importKey('raw', Buffer.from(this.env.ENCRYPTION_KEY, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);
    this.additionalData = new TextEncoder().encode('hall-aircon-cloud-v1');
    const stored = await this.ctx.storage.get('connections');
    let decoded = [];
    if (stored) {
      const bytes = Buffer.from(stored);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: this.additionalData }, this.key, Buffer.concat([bytes.subarray(28), bytes.subarray(12, 28)]));
      decoded = JSON.parse(new TextDecoder().decode(decrypted));
    }
    if (Array.isArray(decoded)) {
      const eligible = decoded.filter(s => s.expiresAt > Date.now() && (s.mode === 'live' || s.timer?.state === 'scheduled'));
      const candidates = eligible.length ? eligible : decoded.filter(s => s.expiresAt > Date.now() && (s.mode || s.timer || s.lastResult));
      this.data = { version: 2, rooms: candidates.length === 1 ? [this.roomRecord(candidates[0])] : [], devices: [], loginLimit: null,
        legacy: candidates.length > 1 ? candidates : [] };
    } else {
      if (decoded.version !== 2 || !Array.isArray(decoded.rooms) || !Array.isArray(decoded.devices)) throw new Error('Unsupported private storage format');
      this.data = decoded;
    }
    this.origin = origin;
    if (!this.data.legacy?.length) this.buildApp();
  }
  roomRecord(record) { return { ...record, id: ROOM_ID, expiresAt: Number.MAX_SAFE_INTEGER }; }
  buildApp() {
    this.app = createApp({ client: createDaikinClient(fetch, { cloud: true }), hostedOrigin: this.origin, sharedRoom: true, history: this.history(),
      initialRecords: this.data.rooms, vault: { save: async records => {
        await this.save({ ...this.data, rooms: records });
      } },
    });
  }
  // Readings hold no credentials or identity, so they are stored unencrypted in one small record per hour.
  history() {
    const storage = this.ctx.storage;
    return {
      months: async () => [...(await storage.list({ prefix: 'd:' })).keys()].map(key => key.slice(2)),
      month: id => storage.get(`d:${id}`),
      putMonth: (id, value) => storage.put(`d:${id}`, value),
      async append(row) {
        const key = `h:${Math.floor(row.t / 3600000)}`;
        await storage.put(key, [...(await storage.get(key) ?? []), row]);
      },
      async read(since) {
        const keys = [];
        for (let hour = Math.floor(since / 3600000); hour <= Math.floor(Date.now() / 3600000); hour++) keys.push(`h:${hour}`);
        const rows = [];
        // Durable Object storage reads at most 128 keys per call.
        for (let i = 0; i < keys.length; i += 100) {
          const found = await storage.get(keys.slice(i, i + 100));
          for (const key of keys.slice(i, i + 100)) rows.push(...(found.get(key) ?? []));
        }
        return rows.filter(row => row.t >= since);
      },
    };
  }
  async save(next) {
    let stage = 'encryption';
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.additionalData }, this.key, new TextEncoder().encode(JSON.stringify(next))));
      const payload = new Uint8Array(Buffer.concat([iv, encrypted.subarray(-16), encrypted.subarray(0, -16)]));
      const times = [...next.devices.map(s => s.expiresAt), ...[...next.rooms, ...(next.legacy ?? [])].flatMap(s => s.timer?.state === 'scheduled' ? [s.timer.nextAttempt] : []),
        // Wake for the next logged reading or Saver switch.
        ...next.rooms.flatMap(s => Number.isFinite(s.nextPoll) && (s.mode === 'live' || s.saver?.state === 'running') ? [s.nextPoll] : [])];
      stage = 'transaction';
      await this.ctx.storage.transaction(async txn => {
        stage = 'write'; await txn.put('origin', this.origin); await txn.put('connections', payload);
        stage = 'alarm';
        if (times.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...times)));
        else await this.ctx.storage.deleteAlarm();
      });
      this.data = structuredClone(next);
    } catch {
      const error = new Error('Cloud storage failed'); error.storageStage = stage; throw error;
    }
  }
  async readBody(request) {
    if (request.headers.get('content-type') !== 'application/json') return { error: json({ error: 'Expected JSON.' }, 415) };
    let bytes = Buffer.alloc(0);
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        if (bytes.length + value.length > 10000) { await reader.cancel(); return { error: json({ error: 'Request too large.' }, 413) }; }
        bytes = Buffer.concat([bytes, Buffer.from(value)]);
      }
    }
    try {
      const value = JSON.parse(bytes.toString());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return { value, bytes };
    } catch { return { error: json({ error: 'Invalid JSON.' }, 400) }; }
  }
  fetch(request) {
    return this.serial(async () => {
      try { return await this.handle(request); }
      catch (error) {
        this.app = null; this.key = null;
        const stage = ['encryption', 'transaction', 'write', 'alarm'].includes(error.storageStage) ? error.storageStage : 'unknown';
        return json({ error: `Could not save or restore cloud state (${stage}). Please try again.` }, 503);
      }
    });
  }
  async handle(request) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return json({ error: 'HTTPS required.' }, 403);
    if (url.search) return json({ error: 'Query parameters are not accepted.' }, 400);
    await this.initialize(url.origin);
    if (request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'Cross-site requests are blocked.' }, 403);
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
    let body;
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Request verification failed.' }, 403);
      body = await this.readBody(request); if (body.error) return body.error;
    }
    const passwordVersion = digest(this.env.ACCESS_PASSWORD);
    const token = /(?:^|;\s*)__Host-aircon_access=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1];
    const device = token && this.data.devices.find(d => d.hash === digest(token) && d.expiresAt > Date.now() && d.passwordVersion === passwordVersion);
    if (url.pathname === '/api/access/login') {
      if (request.method !== 'POST') return json({ error: 'Expected POST.' }, 405);
      const stamp = Date.now();
      const limit = this.data.loginLimit?.until > stamp ? this.data.loginLimit : { until: stamp + 60000, count: 0 };
      if (limit.count >= 6) return json({ error: 'Too many sign-in attempts. Try again in a minute.' }, 429);
      if (typeof body.value.password !== 'string' || body.value.password.length > 1024 || !matches(body.value.password, this.env.ACCESS_PASSWORD)) {
        await this.save({ ...this.data, loginLimit: { ...limit, count: limit.count + 1 } });
        return json({ error: 'Incorrect app password.' }, 401);
      }
      const credential = randomBytes(32).toString('base64url');
      const remember = body.value.remember !== false;
      const devices = this.data.devices.filter(d => d.expiresAt > stamp && d.passwordVersion === passwordVersion && d.hash !== device?.hash);
      if (devices.length >= 20) return json({ error: 'Device limit reached. Sign in on an existing device and log out all devices.' }, 429);
      devices.push({ hash: digest(credential), csrf: randomBytes(32).toString('base64url'), expiresAt: stamp + (remember ? REMEMBER_MS : SESSION_MS), passwordVersion, remember });
      await this.save({ ...this.data, devices, loginLimit: null });
      return json({ authenticated: true, hosted: true }, 200, { 'Set-Cookie': accessCookie(credential, remember ? REMEMBER_MS / 1000 : undefined) });
    }
    if (!device) {
      if (url.pathname === '/api/session' && request.method === 'GET') return json({ authenticated: false, hosted: true });
      return json({ error: 'Your app sign-in expired. Sign in again.', accessExpired: true }, 401);
    }
    if (request.method === 'POST' && !matches(request.headers.get('x-csrf-token'), device.csrf)) return json({ error: 'Request verification failed. Reload the page.' }, 403);
    // Remembered devices stay signed in for 30 days after last use, renewed at most daily. Older records lack the flag.
    const renew = {};
    if ((device.remember ?? device.expiresAt - Date.now() > SESSION_MS) && device.expiresAt - Date.now() < REMEMBER_MS - 86400000) {
      await this.save({ ...this.data, devices: this.data.devices.map(d => d.hash === device.hash ? { ...d, remember: true, expiresAt: Date.now() + REMEMBER_MS } : d) });
      renew['Set-Cookie'] = accessCookie(token, REMEMBER_MS / 1000);
    }
    if (['/api/access/logout', '/api/access/revoke'].includes(url.pathname)) {
      if (request.method !== 'POST') return json({ error: 'Expected POST.' }, 405);
      await this.save({ ...this.data, devices: url.pathname.endsWith('/revoke') ? [] : this.data.devices.filter(d => d.hash !== device.hash) });
      return json({ authenticated: false, hosted: true }, 200, { 'Set-Cookie': expiredCookie });
    }
    if (this.data.legacy?.length) {
      if (url.pathname === '/api/migration' && request.method === 'POST') {
        const selected = this.data.legacy.find(s => s.id === body.value.id);
        if (!selected) return json({ error: 'Choose an existing connection.' }, 400);
        await this.save({ ...this.data, rooms: [this.roomRecord(selected)], legacy: [] });
        this.buildApp();
      } else {
        return json({ authenticated: true, hosted: true, csrf: device.csrf, migration: this.data.legacy.map((s, i) => ({ id: s.id, label: `Connection ${i + 1}`, mode: s.mode, dueAt: s.timer?.state === 'scheduled' ? s.timer.dueAt : null, checkedAt: s.status?.checkedAt ?? null })) }, 200, renew);
      }
    }
    // A fresh app needs its room/CSRF initialized before forwarding another endpoint.
    if (!this.app.csrf()) await this.invoke('/api/session', 'GET', {}, null);
    const forwardedHeaders = Object.fromEntries(request.headers);
    if (request.method === 'POST') forwardedHeaders['x-csrf-token'] = this.app.csrf();
    const result = await this.invoke(url.pathname === '/api/migration' ? '/api/session' : url.pathname, url.pathname === '/api/migration' ? 'GET' : request.method, forwardedHeaders, body?.bytes);
    const value = JSON.parse(result.body);
    if (result.status < 400) { value.csrf = device.csrf; value.authenticated = true; value.hosted = true; }
    return json(value, result.status, renew);
  }
  async invoke(path, method, reqHeaders, bytes) {
    const req = { method, url: path, headers: reqHeaders, socket: {},
      async *[Symbol.asyncIterator]() { if (bytes) yield bytes; },
    };
    let status = 200; let body;
    const res = { setHeader: () => {}, writeHead: code => { status = code; }, end: value => { body = value; } };
    await this.app.handler(req, res);
    if (status >= 500) {
      // Reload durable state on a failed save so subsequent reads cannot show an unsaved schedule.
      this.app = null; this.key = null;
    }
    return { status, body };
  }
  alarm() {
    return this.serial(async () => {
      try {
        await this.initialize(await this.ctx.storage.get('origin'));
        // Preserve legacy jobs until the owner selects a connection. Never discard an unseen shutdown.
        if (this.data.legacy?.length) {
          const app = createApp({ client: createDaikinClient(fetch, { cloud: true }), hostedOrigin: this.origin,
            initialRecords: this.data.legacy, vault: { save: async records => this.save({ ...this.data, legacy: records }) } });
          try { await app.tick(); } finally { app.close(); }
        } else await this.app.tick();
        await this.save({ ...this.data, devices: this.data.devices.filter(d => d.expiresAt > Date.now()) });
      } catch (error) {
        this.app = null; this.key = null; throw error;
      }
    });
  }
}
