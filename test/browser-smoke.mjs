// Run after: npm run cloud:check -- --outdir /tmp/hall-aircon-build
// Uses local workerd/SQLite and fake app credentials; never connects to real equipment.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import http from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const password = 'browser-test-private-password-0123456789';
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/schedule.js': ['schedule.js', 'text/javascript'], '/usage.js': ['usage.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] };
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'aircon', modules: true, modulesRoot: '/tmp/hall-aircon-build', scriptPath: '/tmp/hall-aircon-build/worker.js', compatibilityDate: '2026-10-07', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { AIRCON: { className: 'Aircon', useSQLite: true } },
  bindings: { ACCESS_PASSWORD: password, ENCRYPTION_KEY: 'ab'.repeat(32) },
  serviceBindings: { ASSETS: async req => { const file = files[new URL(req.url).pathname]; return file ? new Response(await readFile(new URL('../public/' + file[0], import.meta.url)), { headers: { 'content-type': file[1] } }) : new Response('missing', { status: 404 }); } },
}] }));
let chrome, ws, server;
try {
  await mf.ready;
  server = http.createServer(async (req, res) => {
    try {
      const origin = 'https://' + req.headers.host;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const headers = { ...req.headers };
      if (headers.origin) headers.origin = headers.origin.replace('http:', 'https:');
      const response = await mf.dispatchFetch(origin + req.url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { console.error(error); res.writeHead(500); res.end('test proxy error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'aircon-browser-'));
  chrome = spawn(process.env.AIRCON_CHROME_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'), ['--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const debuggerUrl = await new Promise((resolve, reject) => {
    let output = ''; chrome.stderr.on('data', value => { output += value; const match = /DevTools listening on (ws:\/\/\S+)/.exec(output); if (match) resolve(match[1]); });
    chrome.once('error', reject); chrome.once('exit', code => reject(new Error('Browser exited ' + code + ': ' + output.slice(-500))));
    setTimeout(() => reject(new Error('Browser start timed out')), 10000).unref();
  });
  ws = new WebSocket(debuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id) { const callbacks = pending.get(msg.id); pending.delete(msg.id); msg.error ? callbacks.reject(new Error(JSON.stringify(msg.error))) : callbacks.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ': ' + msg.params.exceptionDetails.exception?.description); };
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const target = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await command('Runtime.enable', {}, sessionId); await command('Page.enable', {}, sessionId);
  const evaluate = async expression => { const out = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text); return out.result.value; };
  const until = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out waiting for ' + expression + '\n' + await evaluate('document.body.innerText') + '\n' + JSON.stringify(errors)); };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await command('Page.navigate', { url: base }, sessionId);
  await until("document.querySelector('#access') && !document.querySelector('#access').hidden");
  await evaluate(`document.querySelector('#access-password').value = ${JSON.stringify(password)}; document.querySelector('#access-form').requestSubmit()`);
  await until("!document.querySelector('#connect').hidden && document.querySelector('#access').hidden && !document.querySelector('#practice').disabled");
  await click('#practice'); await until("!document.querySelector('#controls').hidden");
  await click('#power'); await until("document.querySelector('#power').getAttribute('aria-pressed') === 'true' && document.querySelector('#power-state').textContent === 'Cooling' && !document.querySelector('#power').disabled");
  await click('#clock-mode'); assert.equal(await evaluate("document.querySelector('#minutes').disabled"), true);
  assert.match(await evaluate("document.querySelector('#timer-preview').textContent"), /Singapore time/);
  await click('#duration-mode');
  await evaluate("document.querySelector('#minutes').value = 1; document.querySelector('#timer-form').requestSubmit()");
  await until("!document.querySelector('#timer-result').hidden && !document.querySelector('#save-timer').disabled");
  const timerBefore = await evaluate("document.querySelector('#timer-time').textContent");
  await command('Page.reload', {}, sessionId);
  await until("document.querySelector('#timer-result') && !document.querySelector('#timer-result').hidden");
  assert.equal(await evaluate("document.querySelector('#timer-time').textContent"), timerBefore);
  await until("!document.querySelector('#disconnect').disabled"); await click('#disconnect');
  await until("document.querySelector('#confirm-dialog').open");
  assert.equal(await evaluate("document.querySelector('#confirm-dialog button[value=confirm]').disabled"), false);
  await click('#confirm-dialog button[value=cancel]'); await until("!document.querySelector('#disconnect').disabled");
  assert.equal(await evaluate("document.querySelector('#timer-result').dataset.state"), 'scheduled');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  await writeFile('/tmp/aircon-mobile.png', Buffer.from(screenshot.data, 'base64'));
  await click('#logout'); await until("!document.querySelector('#access').hidden");
  await evaluate(`document.querySelector('#access-password').value = ${JSON.stringify(password)}; document.querySelector('#access-form').requestSubmit()`);
  await until("!document.querySelector('#timer-result').hidden");
  assert.equal(await evaluate("document.querySelector('#timer-result').dataset.state"), 'scheduled');
  // Schedule a short practice alarm, close the page, and read its outcome only after it should have run.
  const job = await evaluate(`(async () => { const state = await (await fetch('/api/session')).json(); const dueAt = Date.now() + 2500; return (await (await fetch('/api/timer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ dueAt }) })).json()).timer; })()`);
  assert.ok(job?.id); await command('Target.closeTarget', { targetId: target.targetId });
  await new Promise(resolve => setTimeout(resolve, 4000));
  const newTarget = await command('Target.createTarget', { url: base });
  const newSession = (await command('Target.attachToTarget', { targetId: newTarget.targetId, flatten: true })).sessionId;
  await command('Runtime.enable', {}, newSession);
  let result;
  for (let i = 0; i < 50; i++) {
    const out = await command('Runtime.evaluate', { expression: "fetch('/api/state').then(r => r.json())", awaitPromise: true, returnByValue: true }, newSession);
    result = out.result.value; if (result?.timer?.state === 'completed') break; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(result?.timer?.state, 'completed'); assert.equal(result.status.power, false);
  assert.deepEqual(errors, []);
  console.log('PASS: real workerd/SQLite login, clock inputs, timer reload, confirmation, mobile layout, logout/relogin, and alarm with the page closed. Screenshot: /tmp/aircon-mobile.png');
} finally {
  ws?.close(); chrome?.kill(); if (server) await new Promise(resolve => server.close(resolve)); await mf.dispose();
}
