# Automatic login and remembered connections

## One-time setup (desktop Chrome / Edge)

1. Start the server with `npm start` and open http://127.0.0.1:3000.
2. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, click **Load unpacked** and select this project's `extension` folder.
3. Refresh the demo. It should say **Login helper ready**.

Click **Sign in with NTU**. Enter your password only on `loginfs.ntu.edu.sg`. The helper captures Daikin's return code, sends it to the local server and brings you back to the demo. No copying is needed. Login never sends an on/off command. Manual transfer remains available under **Connect manually instead**.

The extension has permission only for loopback pages and Daikin's specific return path. It does not run on NTU's login page, capture passwords, inspect cookies, intercept network traffic, or retain the return code or aircon token. A one-time pairing ticket is stored temporarily in browser session storage, bound to the login tab and expires after 10 minutes. The server issues it only through a session/CSRF-protected request and requires it for the automatic capture endpoint. A cancelled/used/expired ticket cannot connect an account. The extension redirects away from the credential address after transfer; browser history may still contain it.

**Actual extension execution needs testing in your desktop Chrome/Edge browser.** This is not an iPhone Safari extension. A regular webpage cannot read a cross-origin tab. iPhone automatic capture needs a native wrapper/Safari extension or provider-approved redirect integration; hosting alone does not solve that.

## Persistent storage

**Keep me connected** is selected by default. The aircon token, browser session and timers are encrypted with AES-256-GCM in `~/.local/share/better-hall-aircon/state.enc`, outside the repository. A random encryption key is stored in that directory's `key` file. On Unix the directory must be private (700), and the key private (600). Writes use temporary files and atomic replacement; modified ciphertext is rejected.

This uses file-based key protection, **not an OS keychain**. Someone who can read your whole user account can also read the key. Windows users need private user-directory ACLs; Unix mode checks do not apply there. No NTU passwords/cookies, SAML assertions, or login return codes are persisted. Keep this directory out of shared storage and source control.

The browser keeps an HTTP-only, SameSite=Strict cookie with a 30-day local expiry. The same browser remains connected across server restarts until the local session or Daikin token expires. Restart rotates CSRF secrets. A rejected upstream token clears the saved connection; no verified token-refresh API exists, so another official sign-in may be needed. Unchecking **Keep me connected** keeps the token in memory only.

Remove connection clears the local connection and cancels its pending timer after confirmation. It does not revoke the upstream token or turn the aircon off. Backups may retain old credentials; the app does not claim secure disk erasure.

Timers survive restarts, but the computer must stay awake/online and the server must run. A timer overdue by more than two minutes is marked failed, rather than sending an off command hours later. A completed or cancelled schedule does not run again.

The server is loopback-only. For remote hosting, use HTTPS, Secure cookies, managed encryption keys and a production authentication review. Browser WebMCP reading is optional and unverified here. Real NTU login exchange and power/22°C commands were verified earlier; tests of this change do not operate real equipment.
