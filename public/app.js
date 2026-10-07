const $ = id => document.getElementById(id);
let csrf = '';
let state = null;
let working = false;
let helperReady = false;
let temperatureDirty = false;
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(path, body) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store',
    ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed.');
  if (value.csrf) csrf = value.csrf;
  const { loginTicket, ...safeState } = value;
  state = safeState; render(); return value;
}
const time = stamp => new Date(stamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
function render() {
  document.querySelector('main').setAttribute('aria-busy', String(working || Boolean(state?.busy)));
  $('loading').hidden = Boolean(state) || !working;
  if (!state) return;
  if (!state.connected) temperatureDirty = false;
  document.querySelector('main').classList.toggle('is-connected', state.connected);
  $('intro-title').textContent = state.connected ? 'Your room, at a glance.' : 'Sleep well. We’ll handle the off.';
  $('intro-description').textContent = state.connected ? 'Cool down now. Switch off when you’re ready.' : 'Room controls and a shutdown timer, in one place.';
  $('connect').hidden = state.connected;
  $('controls').hidden = !state.connected;
  if (!state.connected && state.lastResult) notice(state.lastResult.message);
  $('login-waiting').hidden = !state.loginWaiting;
  $('cancel-login').hidden = !state.loginWaiting;
  $('helper-status').textContent = helperReady ? 'Login helper ready. Your return code will be captured automatically.' : 'Install the login helper below for automatic capture, or use manual connection.';
  $('mode').textContent = state.mode === 'live' ? 'Connected to Daikin' : 'Practice mode';
  $('practice-note').hidden = state.mode !== 'practice';
  $('temperature').textContent = state.status?.temperature ?? '--';
  $('power-state').textContent = state.status ? `Aircon is ${state.status.power ? 'on' : 'off'}` : 'Status unavailable';
  $('checked').textContent = state.status ? `Last checked ${time(state.status.checkedAt)}` : '';
  const limits = state.temperatureLimits ?? { min: 22, max: 30 };
  $('setpoint').min = limits.min; $('setpoint').max = limits.max;
  if (!temperatureDirty) $('setpoint').value = state.status?.setpoint ?? 25;
  $('temperature-current').textContent = state.status?.setpoint != null ? `Currently set to ${state.status.setpoint}°C` : 'Current target unavailable';
  $('temperature-help').textContent = state.status?.power ? `Demo range: ${limits.min}-${limits.max}°C. Daikin may apply narrower limits. Your sleep timer stays set.` : 'Turn the aircon on to change its target temperature. Your sleep timer stays set.';
  $('last-result').textContent = state.lastResult ? `${state.mode === 'practice' ? 'Practice: ' : ''}${state.lastResult.message} (${time(state.lastResult.at)})` : '';
  const timer = state.timer;
  $('timer-result').hidden = !timer;
  $('timer-state').textContent = timer ? ({ scheduled: 'Shutdown scheduled', completed: 'Shutdown confirmed', failed: 'Shutdown failed' })[timer.state] : '';
  $('timer-time').textContent = timer ? time(timer.dueAt) : '';
  $('cancel').hidden = timer?.state !== 'scheduled';
  countdown();
  document.querySelectorAll('button').forEach(button => { button.disabled = working || state.busy; });
  document.querySelectorAll('[data-minutes]').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('selected'))));
  $('automatic-login').disabled = working || state.busy || !helperReady || state.loginWaiting;
  const temperatureDisabled = working || state.busy || !state.status?.power;
  $('setpoint').disabled = temperatureDisabled;
  $('apply-temperature').disabled = temperatureDisabled;
  $('temperature-down').disabled = temperatureDisabled || Number($('setpoint').value) <= limits.min;
  $('temperature-up').disabled = temperatureDisabled || Number($('setpoint').value) >= limits.max;
}
function countdown() {
  if (!state?.timer) return;
  const t = state.timer;
  const left = Math.max(0, Math.ceil((t.dueAt - Date.now()) / 1000));
  $('countdown').textContent = t.state === 'completed' ? 'The service reports your aircon is off.' : t.state === 'failed' ? 'Check the official app and turn off manually if needed.' : left ? `${Math.floor(left / 3600)}h ${Math.floor(left % 3600 / 60)}m ${left % 60}s remaining` : 'Shutdown due. Waiting for confirmation…';
}
async function action(fn) {
  if (working) return;
  working = true; notice(); render();
  try { await fn(); } catch (error) { notice(error.message); }
  finally { working = false; render(); }
}
$('connect-form').addEventListener('submit', event => {
  event.preventDefault(); const token = $('token').value; $('token').value = '';
  void action(() => api('/api/connect', { token, remember: $('remember').checked }));
});
$('automatic-login').addEventListener('click', () => action(async () => {
  if (!helperReady) throw new Error('Install the login helper first.');
  const value = await api('/api/login/start', { remember: $('remember').checked });
  window.postMessage({ source: 'hall-aircon-app', type: 'start', ticket: value.loginTicket }, location.origin);
}));
$('cancel-login').addEventListener('click', () => action(() => api('/api/login/cancel', {})));
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'hall-aircon-helper') return;
  if (event.data.type === 'ready') { helperReady = true; render(); }
  if (event.data.type === 'started' && !event.data.ok) {
    void action(async () => { await api('/api/login/cancel', {}); throw new Error('Could not open the login tab. Reload the helper and try again.'); });
  }
});
setTimeout(() => window.postMessage({ source: 'hall-aircon-app', type: 'hello' }, location.origin), 300);
$('practice').addEventListener('click', () => action(() => api('/api/practice', {})));
$('disconnect').addEventListener('click', () => action(async () => { await api('/api/disconnect', {}); temperatureDirty = false; }));
$('refresh').addEventListener('click', () => action(() => api('/api/status', {})));
$('on').addEventListener('click', () => action(() => api('/api/power', { power: true })));
$('off').addEventListener('click', () => action(() => api('/api/power', { power: false })));
$('temperature-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => { await api('/api/temperature', { setpoint: Number($('setpoint').value) }); temperatureDirty = false; });
});
$('setpoint').addEventListener('input', () => { temperatureDirty = true; render(); });
for (const [id, step] of [['temperature-down', -1], ['temperature-up', 1]]) {
  $(id).addEventListener('click', () => {
    const input = $('setpoint');
    const value = Number(input.value);
    input.value = Math.max(Number(input.min), Math.min(Number(input.max), (Number.isFinite(value) && input.value ? value : state.status?.setpoint ?? 25) + step));
    temperatureDirty = true; render();
  });
}
$('timer-form').addEventListener('submit', event => { event.preventDefault(); void action(() => api('/api/timer', { minutes: Number($('minutes').value) })); });
$('cancel').addEventListener('click', () => action(() => api('/api/timer', { cancel: true })));
document.querySelectorAll('[data-minutes]').forEach(button => button.addEventListener('click', () => {
  $('minutes').value = button.dataset.minutes;
  document.querySelectorAll('[data-minutes]').forEach(b => {
    b.classList.toggle('selected', b === button);
    b.setAttribute('aria-pressed', String(b === button));
  });
}));
$('minutes').addEventListener('input', () => document.querySelectorAll('[data-minutes]').forEach(b => {
  const selected = b.dataset.minutes === $('minutes').value;
  b.classList.toggle('selected', selected);
  b.setAttribute('aria-pressed', String(selected));
}));
void action(() => api('/api/session'));
setInterval(countdown, 1000);
// Poll only our local state. Daikin is queried on connection, refresh and commands.
setInterval(() => { if (!working && (state?.connected || state?.loginWaiting)) void api('/api/state').catch(error => notice(error.message)); }, 3000);
// Agent-facing read access only; sensitive tokens are never exposed.
try { document.modelContext?.registerTool({ name: 'read_aircon_status', description: 'Read the displayed aircon state and shutdown schedule without sending a command.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: async () => { await api('/api/state'); const { csrf: _csrf, ...safe } = state; return safe; } }); } catch { /* Optional browser capability. */ }
