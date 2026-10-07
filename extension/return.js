// This file never runs on loginfs.ntu.edu.sg and does not read page contents.
chrome.runtime.sendMessage({ type: 'returned', returnUrl: location.href }).catch(() => {});
