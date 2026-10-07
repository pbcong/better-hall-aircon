const LOCAL = 'http://127.0.0.1:3000';
const LOGIN = 'https://cmsntu-prod.daikinpayu.com/adfs/login';
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.type === 'start') {
      if (!sender.tab || new URL(sender.url).origin !== LOCAL || !/^[A-Za-z0-9_-]{43}$/.test(message.ticket)) throw new Error('Invalid start');
      const tab = await chrome.tabs.create({ url: 'about:blank' });
      await chrome.storage.session.set({ [`login-${tab.id}`]: { ticket: message.ticket, expiresAt: Date.now() + 600000 } });
      await chrome.tabs.update(tab.id, { url: LOGIN });
      return { ok: true };
    }
    if (message.type === 'returned') {
      if (!sender.tab || sender.url !== message.returnUrl) throw new Error('Invalid return');
      const url = new URL(message.returnUrl);
      if (url.origin !== 'https://cmsntu-prod.daikinpayu.com' || !url.pathname.startsWith('/adfs/saml/redirect/')) throw new Error('Invalid return host');
      const key = `login-${sender.tab.id}`;
      const pending = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      if (!pending || pending.expiresAt <= Date.now()) throw new Error('Expired login');
      const response = await fetch(LOCAL + '/api/login/capture', { method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pending.ticket}` },
        body: JSON.stringify({ returnUrl: message.returnUrl }) });
      // Remove the credential from the address bar by navigating this tab to the local app.
      await chrome.tabs.update(sender.tab.id, { url: LOCAL });
      return { ok: response.ok };
    }
    return { ok: false };
  })().then(reply).catch(() => reply({ ok: false }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { void chrome.storage.session.remove(`login-${tabId}`); });
