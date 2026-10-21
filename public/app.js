import { singaporeDate, nextClockDate, clockTimestamp, describeShutdown, shutdownDay } from './schedule.js';
import { summarize, span, total, drawChart, drawCost, toCsv, dailyCsv, dateLabel, money, duration, clockTime, RATE } from './usage.js';
const $ = id => document.getElementById(id);
let csrf = '';
let state = null;
let working = false;
let helperReady = false;
let temperatureDirty = false;
let timerMode = 'duration';
let timerDirty = false;
let timerSeen = null;
let timerEditing = false;
let customOpen = false;
let pendingPower = null;
let target = null;
let temperatureSending = false;
let temperatureTimer = 0;
let pressed = null;
let toastSeen = null;
let toastTimer = 0;
let dateChosen = false;
let polling = false;
let requestVersion = 0;
let serverOffset = 0;
let saverKind = 'interval';
let usageRows = [];
let usageHours = 24;
let usageLoaded = 0;
const clockNow = () => Date.now() + serverOffset;
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
// Set text and, when it actually changes, replay a short settle animation.
function show(id, text) {
  const node = $(id), value = String(text);
  if (node.textContent === value) return;
  const animate = node.textContent !== '' && node.textContent !== '--';
  node.textContent = value;
  if (animate) roll(node, 'tick');
}
function roll(node, name) { node.classList.remove('tick', 'tick-up', 'tick-down'); void node.offsetWidth; node.classList.add(name); }
// Brief confirmation of the last command; the text stays in the live region for screen readers.
function toast(result) {
  const key = result ? `${result.at}:${result.message}` : null;
  if (key === toastSeen) return;
  const first = toastSeen === null; toastSeen = key;
  $('last-result').textContent = result ? `${state.mode === 'practice' ? 'Practice: ' : ''}${result.message}` : '';
  if (!result || first) return;
  $('last-result').classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('last-result').classList.remove('show'), 3600);
}
// Remember which button started an action so it alone can show a spinner.
document.addEventListener('click', event => { pressed = event.target.closest?.('button') ?? null; }, true);
document.addEventListener('submit', event => { pressed = event.submitter ?? event.target.querySelector('[type=submit]'); }, true);
async function api(path, body) {
  const version = ++requestVersion;
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store',
    ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) } : {}) });
  let value;
  try { value = await response.json(); } catch { throw new Error(response.status === 401 ? 'Sign-in is required. Reload the page to sign in.' : 'The server returned an unreadable response. Try again.'); }
  if (!response.ok) {
    if (value.accessExpired) { state = { authenticated: false, hosted: true }; csrf = ''; render(); }
    throw new Error(value.error ?? 'Request failed.');
  }
  if (version !== requestVersion) return value;
  if (value.serverNow) serverOffset = value.serverNow - Date.now();
  if (value.csrf) csrf = value.csrf;
  if (path === '/api/timer') { timerDirty = false; timerEditing = false; }
  const { loginTicket, history, usage, ...safeState } = value;
  state = safeState; render(); return value;
}
const time = stamp => new Date(stamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function render() {
  document.querySelector('main').setAttribute('aria-busy', String(working || Boolean(state?.busy)));
  $('loading').hidden = Boolean(state) || !working;
  if (!state) return;
  if (!state.connected) { temperatureDirty = false; target = null; }
  const authorized = state.authenticated !== false;
  const migrating = Boolean(state.migration);
  $('access').hidden = authorized;
  $('migration').hidden = !migrating;
  $('open-settings').hidden = !authorized;
  $('device-controls').hidden = !state.hosted || !authorized;
  $('hosting-badge').textContent = state.hosted ? 'Private cloud app' : 'Local app';
  $('automatic-login').hidden = Boolean(state.hosted);
  $('helper-setup').hidden = Boolean(state.hosted);
  $('helper-status').hidden = Boolean(state.hosted);
  $('connection-remember').hidden = Boolean(state.hosted);
  $('remember').checked = state.hosted ? true : $('remember').checked;
  if (state.hosted) {
    $('manual-login').open = true;
    $('manual-summary').textContent = 'Sign in with NTU';
    $('connection-storage').textContent = 'Your Daikin connection is encrypted in private cloud storage. NTU passwords are never saved.';
    $('timer-help').textContent = 'Setting a shutdown does not turn the aircon on. Saved cloud shutdowns run with this page closed and your computer off. Jobs more than two minutes late fail.';
    $('footer-note').textContent = 'Independent NTU student app · Not affiliated with NTU or Daikin. Cloud shutdowns survive page closure and device logout.';
  }
  if (migrating) renderMigration(state.migration);
  document.querySelector('main').classList.toggle('is-connected', Boolean(state.connected || state.timer));
  $('connect').hidden = !authorized || migrating || Boolean(state.connected);
  $('controls').hidden = !authorized || migrating || (!state.connected && !state.timer);
  $('climate').hidden = !state.connected;
  $('settings-connection').hidden = !state.connected && !state.timer;
  $('settings-room').hidden = $('settings-saver').hidden = !state.connected;
  if (!state.connected && state.lastResult) notice(state.lastResult.message);
  $('login-waiting').hidden = !state.loginWaiting;
  $('cancel-login').hidden = !state.loginWaiting;
  $('helper-status').textContent = helperReady ? 'Login helper ready. Your return code will be captured automatically.' : 'Install the login helper below for automatic capture, or connect manually.';
  $('mode').hidden = !state.connected;
  $('mode').dataset.mode = state.mode ?? '';
  $('mode').textContent = state.mode === 'live' ? 'Live' : state.mode === 'practice' ? 'Practice' : 'Sign-in needed';
  $('connection-label').textContent = state.mode === 'live' ? 'Daikin' : state.mode === 'practice' ? 'Practice (simulated)' : 'Sign-in needed';

  // One power control. Saver's rest still counts as on: pressing it ends the session.
  const resting = saverRunning() && state.saver.phase === 'off';
  const on = Boolean(state.status?.power) || resting;
  const power = !state.status ? 'unknown' : resting ? 'rest' : state.status.power ? 'on' : 'off';
  $('climate').dataset.power = power;
  document.body.dataset.power = state.connected ? power : '';
  $('power').setAttribute('aria-pressed', String(pendingPower ?? on));
  $('power').setAttribute('aria-label', on ? 'Turn aircon off' : 'Turn aircon on');
  show('power-state', pendingPower != null ? (pendingPower ? 'Turning on…' : 'Turning off…')
    : !state.status ? 'Status unavailable' : resting ? 'Resting · Saver' : state.status.power ? 'Cooling' : 'Off');
  show('temperature', state.status?.temperature ?? '--');
  const stale = state.status && clockNow() - state.status.checkedAt > 120000;
  $('refresh').hidden = !stale;
  if (stale) $('refresh').textContent = `Last update ${time(state.status.checkedAt)} · Tap to refresh`;

  // Target temperature applies on its own shortly after the last tap.
  const limits = state.temperatureLimits ?? { min: 22, max: 30 };
  const setpoint = temperatureDirty ? target : state.status?.setpoint ?? null;
  if (!temperatureDirty) target = setpoint;
  if ($('setpoint').textContent !== (setpoint == null ? '--' : `${setpoint}°`)) $('setpoint').textContent = setpoint == null ? '--' : `${setpoint}°`;
  $('setpoint').toggleAttribute('data-pending', temperatureDirty);
  $('temperature-current').textContent = temperatureDirty ? (temperatureSending ? `Setting ${target}°…` : '')
    : (!state.status?.power ? (resting ? 'Adjustable when Saver cools again' : 'Turn on to adjust') : '');

  toast(state.lastResult);
  const timer = state.timer;
  const timerKey = timer?.id ?? timer?.dueAt ?? null;
  // A newly saved or restored shutdown collapses the form; Change reopens it.
  if (timerKey !== timerSeen && !timerDirty) { timerEditing = false; customOpen = false; }
  timerSeen = timerKey;
  const scheduled = timer?.state === 'scheduled';
  $('timer-result').hidden = !timer;
  $('timer-result').dataset.state = timer?.state ?? '';
  $('timer-state').textContent = timer ? ({ scheduled: timer.attempts ? 'Retrying shutdown' : 'Turns off at', completed: timer.completedBy === 'manual' ? 'Turned off manually' : 'Turned off', failed: 'Shutdown failed', cancelled: 'Shutdown cancelled' })[timer.state] : '';
  show('timer-time', timer ? clockTime(timer.dueAt) : '');
  $('timer-day').textContent = timer ? `${shutdownDay(timer.dueAt, clockNow())} · Singapore time` : '';
  $('cancel').hidden = !scheduled;
  $('change-timer').hidden = !scheduled || !state.connected;
  $('change-timer').textContent = timerEditing ? 'Keep' : 'Change';
  $('change-timer').setAttribute('aria-expanded', String(timerEditing));
  $('timer-saved').textContent = timer?.state === 'scheduled' ? (state.mode === 'practice' ? 'Practice — no equipment will be controlled.' : state.hosted ? 'Saved in the cloud. You can close this page.' : state.remembered ? 'Saved on this computer. Keep the server running.' : 'Temporary. Keep the server running.') : '';
  $('timer-failure').hidden = timer?.state !== 'failed';
  $('timer-failure').textContent = timer?.error ?? state.lastResult?.message ?? 'Shutdown could not be confirmed. Check your aircon manually.';
  $('timer-form').hidden = !state.connected || (scheduled && !timerEditing);
  $('quick-label').textContent = scheduled ? 'Change to' : 'Turn off in';
  $('custom-fields').hidden = !customOpen;
  $('custom-timer').setAttribute('aria-expanded', String(customOpen));
  renderSaver(); renderUsage();
  countdown(); preview();
  document.querySelectorAll('button').forEach(button => { if (button.closest('dialog')) return; button.disabled = working || state.busy; });
  $('open-settings').disabled = false;
  $('power').disabled = working || state.busy || temperatureSending;
  $('automatic-login').disabled = working || state.busy || !helperReady || state.loginWaiting;
  $('automatic-login').toggleAttribute('data-unavailable', !helperReady || Boolean(state.loginWaiting));
  // The stepper stays live while its own change is being sent, so taps can keep adjusting.
  const off = !state.status?.power || setpoint == null;
  const blocked = (working && !temperatureSending) || state.busy || off;
  $('temperature-down').disabled = blocked || setpoint <= limits.min;
  $('temperature-up').disabled = blocked || setpoint >= limits.max;
  $('temperature-down').toggleAttribute('data-unavailable', off || setpoint <= limits.min);
  $('temperature-up').toggleAttribute('data-unavailable', off || setpoint >= limits.max);
}
function countdown() {
  saverCountdown();
  if (!state?.timer) return;
  const t = state.timer;
  const left = Math.max(0, Math.ceil((t.dueAt - clockNow()) / 1000));
  $('countdown').textContent = t.state === 'completed' ? 'The service reports your aircon is off.' : t.state === 'cancelled' ? 'This shutdown will not run.' : t.state === 'failed' ? 'Check the official app and turn off manually if needed.' : left ? `in ${left >= 3600 ? `${Math.floor(left / 3600)}h ` : ''}${Math.floor(left % 3600 / 60)}m ${String(left % 60).padStart(2, '0')}s` : 'Shutdown due. Waiting for confirmation…';
}
async function action(fn) {
  if (working) return;
  working = true; notice();
  const button = pressed; pressed = null; button?.classList.add('is-loading');
  render();
  try { await fn(); } catch (error) {
    const message = error.message;
    if (state?.authenticated !== false) { try { await api('/api/session'); } catch { /* Keep the original error visible. */ } }
    notice(message);
  }
  finally { working = false; button?.classList.remove('is-loading'); render(); }
}
$('connect-form').addEventListener('submit', event => {
  event.preventDefault(); const token = $('token').value; $('token').value = '';
  void action(async () => { await api('/api/connect', { token, remember: $('remember').checked }); await loadUsage(); });
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
$('disconnect').addEventListener('click', () => {
  void action(async () => {
    if (!await confirmAction('Remove aircon connection?', state?.timer?.state === 'scheduled' ? 'This cancels your pending shutdown and removes the saved Daikin connection. It does not turn the aircon off.' : 'This removes the saved connection. It does not turn the aircon off.')) return;
    await api('/api/disconnect', { confirm: true }); temperatureDirty = false; $('settings-dialog').close();
  });
});
$('refresh').addEventListener('click', () => action(async () => { await api('/api/status', {}); await loadUsage(); }));
// Power flips optimistically so the room lights up at once; a failure renders the real state again.
$('power').addEventListener('click', () => {
  const next = $('power').getAttribute('aria-pressed') !== 'true';
  if (!next) { clearTimeout(temperatureTimer); temperatureDirty = false; }
  void action(async () => {
    pendingPower = next; render();
    try { await api('/api/power', { power: next }); } finally { pendingPower = null; }
    await loadUsage();
  });
});
// Each tap moves the target at once; the command goes out after a short pause so repeated taps send one change.
function nudge(step) {
  const limits = state?.temperatureLimits ?? { min: 22, max: 30 };
  const from = target ?? state?.status?.setpoint ?? 25;
  const next = Math.max(limits.min, Math.min(limits.max, from + step));
  if (next === from) return;
  target = next; temperatureDirty = true;
  $('setpoint').textContent = `${next}°`; roll($('setpoint'), step > 0 ? 'tick-up' : 'tick-down');
  clearTimeout(temperatureTimer); temperatureTimer = setTimeout(sendTemperature, 900);
  render();
}
async function sendTemperature() {
  if (!temperatureDirty) return;
  if (working || polling || temperatureSending) { temperatureTimer = setTimeout(sendTemperature, 400); return; }
  const value = target; temperatureSending = true; render();
  try {
    await api('/api/temperature', { setpoint: value });
    if (target === value) temperatureDirty = false;
  } catch (error) { temperatureDirty = false; notice(error.message); }
  finally {
    temperatureSending = false;
    if (temperatureDirty && target !== value) { clearTimeout(temperatureTimer); temperatureTimer = setTimeout(sendTemperature, 300); }
    render();
  }
}
$('temperature-down').addEventListener('click', () => nudge(-1));
$('temperature-up').addEventListener('click', () => nudge(1));

// Quick timers: one tap schedules. The four durations are editable in Settings and kept on this device.
const QUICK_DEFAULT = [30, 60, 120, 180];
function quickTimes() {
  try {
    const saved = JSON.parse(localStorage.getItem('aircon.quick'));
    if (Array.isArray(saved) && saved.length === 4 && saved.every(n => Number.isInteger(n) && n >= 1 && n <= 1440)) return saved;
  } catch { /* Storage can be unavailable; defaults are fine. */ }
  return QUICK_DEFAULT;
}
const chipLabel = m => m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
function renderChips() {
  const chips = quickTimes().map(minutes => {
    const button = document.createElement('button');
    button.type = 'submit'; button.dataset.minutes = minutes; button.textContent = chipLabel(minutes);
    button.setAttribute('aria-label', `Turn off in ${duration(minutes * 60000)}`);
    return button;
  });
  const custom = document.createElement('button');
  custom.type = 'button'; custom.id = 'custom-timer'; custom.textContent = 'Custom'; custom.setAttribute('aria-controls', 'custom-fields');
  custom.addEventListener('click', () => {
    customOpen = !customOpen; if (customOpen) timerDirty = true; render();
    if (customOpen) (timerMode === 'clock' ? $('shutdown-time') : $('minutes')).focus({ preventScroll: true });
  });
  $('quick-timers').replaceChildren(...chips, custom);
}
renderChips();
$('timer-form').addEventListener('submit', event => {
  event.preventDefault();
  const quick = event.submitter?.dataset.minutes;
  void action(async () => {
    const payload = quick ? { minutes: Number(quick) } : timerMode === 'duration' ? { minutes: Number($('minutes').value) } : { dueAt: clockTimestamp($('shutdown-date').value, $('shutdown-time').value) };
    await api('/api/timer', payload);
  });
});
$('cancel').addEventListener('click', () => action(() => api('/api/timer', { cancel: true })));
$('minutes').addEventListener('input', () => { timerDirty = true; preview(); });

// Settings sheet.
function fillQuick() { quickTimes().forEach((minutes, i) => { $(`quick-${i}`).value = minutes; }); }
$('open-settings').addEventListener('click', () => { fillQuick(); $('settings-dialog').showModal(); });
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
for (const id of ['settings-dialog', 'saver-dialog']) $(id).addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
for (let i = 0; i < 4; i++) $(`quick-${i}`).addEventListener('change', () => {
  const values = [0, 1, 2, 3].map(n => Math.round(Number($(`quick-${n}`).value)));
  if (!values.every(n => n >= 1 && n <= 1440)) { fillQuick(); return; }
  try { localStorage.setItem('aircon.quick', JSON.stringify([...values].sort((a, b) => a - b))); } catch { /* Keep defaults. */ }
  fillQuick(); renderChips(); render();
});
$('quick-reset').addEventListener('click', () => { try { localStorage.removeItem('aircon.quick'); } catch { /* Nothing saved. */ } fillQuick(); renderChips(); render(); });
void action(async () => { await api('/api/session'); await loadUsage(); });
setInterval(() => { countdown(); preview(); }, 1000);
// Poll room state while visible; refresh Daikin once when returning to the app.
async function recover(fresh = false) {
  if (working || polling || temperatureSending || document.hidden || !navigator.onLine || state?.authenticated === false) return;
  polling = true;
  try {
    await api('/api/session');
    if (fresh && state?.connected && !state.migration) await api('/api/status', {});
    if (state?.mode === 'live' && (fresh || Date.now() - usageLoaded > 60000)) await loadUsage();
  } catch (error) {
    const message = error.message;
    if (state?.authenticated !== false) { try { await api('/api/session'); } catch { /* Preserve the original failure. */ } }
    notice(message);
  } finally { polling = false; }
}
setInterval(() => { void recover(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void recover(true); });
window.addEventListener('online', () => { notice(); void recover(true); });
window.addEventListener('offline', () => notice('This device is offline. An already saved cloud shutdown still runs independently.'));
// Agent-facing read access only; sensitive tokens are never exposed.
try { document.modelContext?.registerTool({ name: 'read_aircon_status', description: 'Read the displayed aircon state and shutdown schedule without sending a command.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: async () => { await api('/api/state'); const { csrf: _csrf, ...safe } = state; return safe; } }); } catch { /* Optional browser capability. */ }

function preview() {
  const now = clockNow();
  if (!dateChosen) $('shutdown-date').value = nextClockDate($('shutdown-time').value, now);
  $('shutdown-date').min = singaporeDate(now);
  $('shutdown-date').max = singaporeDate(now + 86400000);
  const due = timerMode === 'clock' ? clockTimestamp($('shutdown-date').value, $('shutdown-time').value) : now + Number($('minutes').value) * 60000;
  const left = Math.ceil((due - now) / 60000);
  $('timer-preview').textContent = Number.isFinite(due) && left > 0 && left <= 1440 ? `Turns off ${describeShutdown(due, now)} · in ${left >= 60 ? `${Math.floor(left / 60)}h ` : ''}${left % 60}m` : 'Choose a future shutdown within the next 24 hours.';
  $('save-timer').textContent = state?.timer?.state === 'scheduled' ? 'Save new time' : 'Set shutdown';
}
function chooseMode(mode) {
  timerMode = mode;
  $('duration-mode').setAttribute('aria-pressed', String(mode === 'duration'));
  $('clock-mode').setAttribute('aria-pressed', String(mode === 'clock'));
  $('duration-fields').hidden = mode !== 'duration';
  $('clock-fields').hidden = mode !== 'clock';
  $('minutes').disabled = mode !== 'duration';
  $('shutdown-time').disabled = mode !== 'clock';
  $('shutdown-date').disabled = mode !== 'clock';
  preview();
}
$('duration-mode').addEventListener('click', () => { timerDirty = true; chooseMode('duration'); });
$('clock-mode').addEventListener('click', () => { timerDirty = true; chooseMode('clock'); });
$('shutdown-time').addEventListener('input', () => { timerDirty = true; preview(); });
$('shutdown-date').addEventListener('input', () => { timerDirty = true; dateChosen = true; preview(); });
$('change-timer').addEventListener('click', () => {
  if (!state?.timer) return;
  timerEditing = !timerEditing; timerDirty = timerEditing;
  if (!timerEditing) customOpen = false;
  render();
});
function confirmAction(title, message) {
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  const dialog = $('confirm-dialog'); dialog.returnValue = '';
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); });
}
$('access-form').addEventListener('submit', event => {
  event.preventDefault(); const password = $('access-password').value; $('access-password').value = '';
  void action(async () => { await api('/api/access/login', { password, remember: $('access-remember').checked }); await api('/api/session'); });
});
$('logout').addEventListener('click', () => action(async () => { await api('/api/access/logout', {}); $('settings-dialog').close(); }));
$('revoke-devices').addEventListener('click', () => action(async () => {
  if (await confirmAction('Log out all devices?', 'Every device will need the app password again. Your saved cloud shutdown will keep running.')) { await api('/api/access/revoke', {}); $('settings-dialog').close(); }
}));
function renderMigration(options) {
  const container = $('migration-options');
  if (container.dataset.ids === options.map(o => o.id).join(',')) return;
  container.dataset.ids = options.map(o => o.id).join(','); container.replaceChildren();
  for (const option of options) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
    button.textContent = `${option.label} · ${option.mode === 'practice' ? 'Practice' : 'Daikin'} · ${option.dueAt ? describeShutdown(option.dueAt) : 'No pending shutdown'}`;
    button.addEventListener('click', () => action(async () => {
      if (await confirmAction('Keep this connection?', 'This preserves the selected connection and its shutdown. Other saved connections and pending shutdowns will be removed.')) await api('/api/migration', { id: option.id });
    })); container.append(button);
  }
}
preview();

// Saver: a switch beside the power buttons; its rarely changed options live in a dialog.
const saverRunning = () => state?.saver?.state === 'running';
function describeSaver(v) {
  return v.kind === 'thermostat' ? `rests at ${v.coolTo}°C, cools again at ${v.warmTo}°C` : `${v.firstMinutes} min first, then ${v.onMinutes} on, ${v.offMinutes} rest`;
}
function renderSaver() {
  if (!state.connected) return;
  const config = state.saverConfig, v = state.saver;
  $('saver-switch').setAttribute('aria-checked', String(Boolean(config?.enabled)));
  $('saver-stopped').hidden = saverRunning() || !v?.reason;
  $('saver-stopped').textContent = v?.reason ?? '';
  $('saver-describe').textContent = !config ? '' : !config.enabled ? 'Off' : config.kind === 'thermostat' ? `${config.coolTo}–${config.warmTo}°C` : `${config.onMinutes} on · ${config.offMinutes} rest`;
  saverCountdown();
}
function saverCountdown() {
  const config = state?.saverConfig;
  if (!state?.connected || !config) return;
  const v = state.saver;
  if (!saverRunning()) {
    $('saver-summary').textContent = !config.enabled ? 'Off · the aircon runs nonstop' : v?.blocked ? 'Stopped · press Turn on to try again'
      : state.status?.power ? 'Starting within a minute…' : 'Rests between cool-downs to save money';
    return;
  }
  const phaseMinutes = v.phase === 'off' ? v.offMinutes : v.switches === 0 ? v.firstMinutes ?? v.onMinutes : v.onMinutes;
  const left = Math.max(0, Math.ceil((v.phaseStart + phaseMinutes * 60000 - clockNow()) / 1000));
  const stamp = `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s`;
  const cooling = v.phase === 'on';
  $('saver-summary').textContent = v.failures ? 'Waiting for Daikin to confirm a switch…'
    : v.kind === 'thermostat' ? (cooling ? `Cooling until the room reads ${v.coolTo}°C` : `Resting until the room reads ${v.warmTo}°C`) + (left ? ` · at least ${stamp}` : '')
    : left ? `${cooling ? 'Cooling · rests' : 'Resting · cools again'} in ${stamp}` : 'Switching…';
}
$('saver-switch').addEventListener('click', () => action(async () => {
  await api('/api/saver', { enabled: !state.saverConfig?.enabled }); await loadUsage();
}));
function chooseSaver(kind) {
  saverKind = kind;
  const thermostat = kind === 'thermostat';
  $('saver-interval').setAttribute('aria-pressed', String(!thermostat));
  $('saver-thermostat').setAttribute('aria-pressed', String(thermostat));
  document.querySelectorAll('.saver-temperature').forEach(field => { field.hidden = !thermostat; });
  $('saver-on-label').textContent = thermostat ? 'Cool at least (min)' : 'Then cool (min)';
  $('saver-off-label').textContent = thermostat ? 'Rest at least (min)' : 'Rest (min)';
  saverPreview();
}
function saverPreview() {
  const on = Number($('saver-on').value), off = Number($('saver-off').value);
  $('saver-preview').textContent = saverKind === 'thermostat'
    ? `Cools until the room reads ${$('saver-cool').value}°C or lower, then rests until it reads ${$('saver-warm').value}°C or higher. Readings are whole degrees.`
    : on > 0 && off > 0 ? `After the first cool-down, switched on ${Math.round(on / (on + off) * 100)}% of the time: about ${Math.round(off / (on + off) * 100)}% cheaper than running nonstop.` : '';
}
$('saver-settings').addEventListener('click', () => {
  const config = state.saverConfig, limits = state.saverLimits;
  for (const id of ['saver-first', 'saver-on', 'saver-off']) { $(id).min = limits.minMinutes; $(id).max = limits.maxMinutes; }
  $('saver-cool').min = limits.minTemperature; $('saver-cool').max = limits.maxTemperature - 1;
  $('saver-warm').min = limits.minTemperature + 1; $('saver-warm').max = limits.maxTemperature;
  $('saver-first').value = config.firstMinutes; $('saver-on').value = config.onMinutes; $('saver-off').value = config.offMinutes;
  $('saver-cool').value = config.coolTo; $('saver-warm').value = config.warmTo;
  $('saver-error').hidden = true; chooseSaver(config.kind); $('saver-dialog').showModal();
});
$('saver-interval').addEventListener('click', () => chooseSaver('interval'));
$('saver-thermostat').addEventListener('click', () => chooseSaver('thermostat'));
for (const id of ['saver-on', 'saver-off', 'saver-cool', 'saver-warm']) $(id).addEventListener('input', saverPreview);
$('saver-cancel').addEventListener('click', () => $('saver-dialog').close());
$('saver-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/saver', { settings: { kind: saverKind, firstMinutes: Number($('saver-first').value), onMinutes: Number($('saver-on').value), offMinutes: Number($('saver-off').value), coolTo: Number($('saver-cool').value), warmTo: Number($('saver-warm').value) } });
    $('saver-dialog').close();
  } catch (error) { $('saver-error').textContent = error.message; $('saver-error').hidden = false; }
});

// Usage: permanent day totals for any period, plus the last week of raw readings for the temperature chart.
let usageFull = 0;
let usageDays = [];
let period = '30';
async function loadUsage() {
  if (state?.mode !== 'live') return;
  usageLoaded = Date.now();
  try {
    usageDays = (await api('/api/usage', {})).usage ?? usageDays;
    if (Date.now() - usageFull > 30 * 60000) { usageRows = (await api('/api/history', { hours: 168 })).history ?? usageRows; usageFull = Date.now(); }
    else {
      const recent = (await api('/api/history', { hours: 2 })).history ?? [];
      if (recent.length) usageRows = [...usageRows.filter(row => row.t < recent[0].t), ...recent];
    }
  } catch { /* Keep the last charts; controls matter more. */ }
  renderUsage();
}
const DAY_MS = 86400000;
const periodNote = sum => `saved ${money(sum.saved)}\non ${duration(sum.onMs)}`;
// Inclusive Singapore dates for the chosen period.
function periodDates(today) {
  const first = usageDays[0]?.date ?? today;
  if (period === 'custom') {
    const from = $('period-from').value || today, to = $('period-to').value || today;
    return from <= to ? [from, to] : [to, from];
  }
  if (period === 'all') return [first < today ? first : today, today];
  if (period === 'month') return [`${today.slice(0, 8)}01`, today];
  return [singaporeDate(clockNow() - (Number(period) - 1) * DAY_MS), today];
}
function renderUsage() {
  const live = state?.mode === 'live';
  $('usage').hidden = !live;
  if (!live) return;
  const now = clockNow(), today = singaporeDate(now);
  const from = now - usageHours * 3600000;
  const summary = summarize(usageRows, now);
  const balance = state.status?.balance ?? summary.balance;
  $('usage-rate').textContent = `${money(RATE)} per hour on`;
  $('usage-balance').textContent = money(balance);
  $('usage-left').textContent = balance > 0 ? `about ${duration(balance / RATE * 3600000)} of cooling` : '';
  for (const [id, count] of [['today', 1], ['week', 7], ['month', 30]]) {
    const sum = total(span(usageDays, singaporeDate(now - (count - 1) * DAY_MS), today));
    $(`usage-${id}`).textContent = money(sum.cost); $(`usage-${id}-note`).textContent = periodNote(sum);
  }
  $('usage-note').textContent = `Saved counts Saver's rest time at the hourly rate.${summary.hourly ? ` Your finished sessions measure ${money(summary.hourly)} per hour.` : ''}${summary.open ? ` The running session is charged when it switches off${summary.open.partial ? '' : ` (about ${money(RATE * summary.open.ms / 3600000)} so far)`}.` : ''}`;
  $('period-custom').hidden = period !== 'custom';
  for (const id of ['period-from', 'period-to']) { $(id).max = today; if (!$(id).value) $(id).value = id === 'period-to' ? today : singaporeDate(now - 6 * DAY_MS); }
  const [first, last] = periodDates(today);
  const days = span(usageDays, first, last);
  const sum = total(days);
  $('period-title').textContent = `${first === last ? dateLabel(first) : `${dateLabel(first)} – ${dateLabel(last)}`} · ${days.length} day${days.length === 1 ? '' : 's'}${usageDays.length && first < usageDays[0].date ? ` · tracking began ${dateLabel(usageDays[0].date)}` : ''}`;
  $('period-spent').textContent = money(sum.cost);
  $('period-saved').textContent = `${money(sum.saved)}${sum.cost + sum.saved > 0 ? ` (${Math.round(sum.saved / (sum.cost + sum.saved) * 100)}%)` : ''}`;
  $('period-on').textContent = duration(sum.onMs);
  // Average over days since tracking began, not empty days before it.
  const tracked = days.filter(day => usageDays.length && day.date >= usageDays[0].date).length;
  $('period-average').textContent = tracked ? money(sum.cost / tracked) : '--';
  $('period-charged').textContent = money(sum.charged);
  $('usage-empty').hidden = usageRows.length > 1;
  if ($('usage-more').open) {
    drawCost($('cost-chart'), $('cost-tip'), days);
    drawChart($('usage-chart'), $('chart-tip'), usageRows.filter(row => row.t >= from), from, now);
  }
  const cell = (row, text, tag = 'td') => { const node = document.createElement(tag); node.textContent = text; row.append(node); };
  const daysBody = $('daily'); daysBody.replaceChildren();
  for (const day of [...days].reverse().filter(day => day.loggedMs || day.charged).slice(0, 400)) {
    const row = document.createElement('tr');
    for (const text of [dateLabel(day.date), duration(day.onMs), duration(day.restMs), money(day.cost), money(day.saved), money(day.charged), String(day.starts), day.room == null ? '--' : `${day.room.toFixed(1)}°C`]) cell(row, text);
    daysBody.append(row);
  }
  const foot = document.createElement('tr');
  for (const text of ['Total', duration(sum.onMs), duration(sum.restMs), money(sum.cost), money(sum.saved), money(sum.charged), String(sum.starts), '']) cell(foot, text, 'th');
  $('daily-total').replaceChildren(foot);
  const body = $('sessions'); body.replaceChildren();
  for (const session of [...summary.sessions].reverse().slice(0, 40)) {
    const row = document.createElement('tr');
    const cells = session.unlogged ? [clockTime(session.end, true), 'not logged', money(session.cost), '--', '--']
      : [clockTime(session.start, true), `${session.partial ? 'over ' : ''}${duration(session.ms)}`, money(session.cost), !session.partial && session.ms >= 60000 && session.cost ? money(session.cost / (session.ms / 3600000)) : '--', session.saver ? 'Saver' : 'Nonstop'];
    for (const text of cells) cell(row, text);
    body.append(row);
  }
  $('sessions-details').hidden = !summary.sessions.length;
}
document.querySelectorAll('[data-hours]').forEach(button => button.addEventListener('click', () => {
  usageHours = Number(button.dataset.hours);
  document.querySelectorAll('[data-hours]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  renderUsage();
}));
function save(name, text) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  link.download = `${name}-${singaporeDate(clockNow())}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
$('download').addEventListener('click', () => action(async () => save('hall-aircon-readings', toCsv((await api('/api/history', { hours: 744 })).history ?? []))));
$('download-daily').addEventListener('click', () => action(async () => { await loadUsage(); const [first, last] = periodDates(singaporeDate(clockNow())); save(`hall-aircon-${first}-to-${last}`, dailyCsv(span(usageDays, first, last))); }));
document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
  period = button.dataset.period;
  document.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  renderUsage();
}));
for (const id of ['period-from', 'period-to']) $(id).addEventListener('change', renderUsage);
window.addEventListener('resize', () => { if (state?.mode === 'live') renderUsage(); });
$('usage-more').addEventListener('toggle', () => { if (state?.mode === 'live') renderUsage(); });
