import { createApp } from '../server.mjs';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function authenticated(request, env) {
  const expected = 'Basic ' + Buffer.from(`owner:${env.ACCESS_PASSWORD}`).toString('base64');
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(request.headers.get('authorization') ?? ''), digest(expected));
}
export default {
  async fetch(request, env) {
    if (!env.ACCESS_PASSWORD || env.ACCESS_PASSWORD.length < 20 || !/^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY ?? '')) {
      return new Response('Configure ACCESS_PASSWORD and ENCRYPTION_KEY first.', { status: 503, headers });
    }
    if (!authenticated(request, env)) return new Response('Sign in with username owner and your private access password.', {
      status: 401, headers: { ...headers, 'WWW-Authenticate': 'Basic realm="Private Hall Aircon", charset="UTF-8"' },
    });
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return new Response('HTTPS required.', { status: 403, headers });
    if (url.pathname.startsWith('/api/')) {
      return env.AIRCON.get(env.AIRCON.idFromName('personal-aircon')).fetch(request);
    }
    if (request.method !== 'GET' || !['/', '/app.js', '/style.css', '/favicon.svg'].includes(url.pathname)) {
      return new Response('Not found.', { status: 404, headers });
    }
    const asset = await env.ASSETS.fetch(request);
    const responseHeaders = new Headers(asset.headers);
    for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value);
    let body = asset.body;
    if (url.pathname === '/') {
      body = (await asset.text())
        .replace('Keep me connected on this computer', 'Save my connection for cloud timers')
        .replace('id="remember" type="checkbox" checked', 'id="remember" type="checkbox" checked disabled')
        .replace('id="automatic-login" class="primary"', 'id="automatic-login" class="primary" hidden')
        .replace(/<details><summary>One-time automatic login setup[\s\S]*?<\/details>/, '')
        .replace('<details><summary>Connect manually instead</summary>', '<details open><summary>Sign in with NTU</summary>')
        .replace('Remembered aircon tokens are encrypted locally.', 'Aircon connections are encrypted in private cloud storage.')
        .replace('Keep this computer awake and the local server running. Closing this tab is fine.', 'Cloudflare runs this timer even with your computer off. Closing this tab is fine.')
        .replace('The local server exchanges', 'The server exchanges');
    }
    if (url.pathname === '/app.js') {
      body = (await asset.text()).replace('Install the login helper below for automatic capture, or use manual connection.', 'Use the official NTU sign-in link below, then paste the final return address.');
    }
    responseHeaders.delete('content-length');
    responseHeaders.delete('etag');
    return new Response(body, { status: asset.status, headers: responseHeaders });
  },
};

// One personal object serializes browser commands and alarms. No permanent interval.
export class Aircon {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  serial(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }
  async initialize(origin) {
    if (this.app) return;
    const key = Buffer.from(this.env.ENCRYPTION_KEY, 'hex');
    const stored = await this.ctx.storage.get('connections');
    let records = [];
    if (stored) {
      const bytes = Buffer.from(stored);
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from('hall-aircon-cloud-v1'));
      cipher.setAuthTag(bytes.subarray(12, 28));
      records = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    }
    const vault = { save: async records => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from('hall-aircon-cloud-v1'));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(records)), cipher.final()]);
      const times = records.flatMap(s => [s.expiresAt, ...(s.timer?.state === 'scheduled' ? [s.timer.nextAttempt] : [])]);
      await this.ctx.storage.transaction(async tx => {
        await tx.put('connections', Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
        if (times.length) await tx.setAlarm(Math.max(Date.now() + 1000, Math.min(...times)));
        else await tx.deleteAlarm();
      });
    } };
    this.app = createApp({ vault, initialRecords: records, hostedOrigin: origin });
  }
  fetch(request) {
    return this.serial(async () => {
      const origin = new URL(request.url).origin;
      await this.ctx.storage.put('origin', origin);
      await this.initialize(origin);
      // Bound input before adapting the existing HTTP handler.
      let bytes = Buffer.alloc(0);
      if (request.body) {
        const reader = request.body.getReader();
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          if (bytes.length + value.length > 10000) { await reader.cancel(); return new Response('Request too large.', { status: 413, headers }); }
          bytes = Buffer.concat([bytes, Buffer.from(value)]);
        }
      }
      const url = new URL(request.url);
      const req = { method: request.method, url: url.pathname + url.search,
        headers: Object.fromEntries(request.headers), socket: {},
        async *[Symbol.asyncIterator]() { if (bytes.length) yield bytes; },
      };
      const out = new Headers(); let status = 200; let body;
      const res = { setHeader: (k, v) => out.set(k, v),
        writeHead: (code, values) => { status = code; for (const [k, v] of Object.entries(values)) out.set(k, v); },
        end: value => { body = value; },
      };
      await this.app.handler(req, res);
      return new Response(body, { status, headers: out });
    });
  }
  alarm() {
    return this.serial(async () => {
      await this.initialize(await this.ctx.storage.get('origin'));
      await this.app.tick();
      const next = this.app.nextAlarm();
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
