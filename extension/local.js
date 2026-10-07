if (location.origin === 'http://127.0.0.1:3000') {
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'hall-aircon-app') return;
    if (event.data.type === 'hello') {
      window.postMessage({ source: 'hall-aircon-helper', type: 'ready' }, location.origin);
    } else if (event.data.type === 'start' && /^[A-Za-z0-9_-]{43}$/.test(event.data.ticket)) {
      chrome.runtime.sendMessage({ type: 'start', ticket: event.data.ticket }).then(result => {
        window.postMessage({ source: 'hall-aircon-helper', type: 'started', ok: result?.ok === true }, location.origin);
      }).catch(() => window.postMessage({ source: 'hall-aircon-helper', type: 'started', ok: false }, location.origin));
    }
  });
}
