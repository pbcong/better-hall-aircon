# Hall Aircon local demo

Run with Node.js 22 or newer:

```sh
npm start
```

Open **http://127.0.0.1:3000** on this computer. No dependencies or hosting account required. Use **Try practice mode** to test on/off and a 1-minute shutdown without touching real equipment.

## Real aircon connection

**Automatic login and persistence are now implemented for the local desktop demo.** See [Automatic login setup and security](AUTOMATIC-LOGIN.md). The manual flow below remains available as a fallback.

The demo supports **NTU sign-in with manual transfer of Daikin's return URL**, plus existing Daikin bearer-token authentication. The verified sign-in entry point is `https://cmsntu-prod.daikinpayu.com/adfs/login`. It redirects to `https://loginfs.ntu.edu.sg/adfs/ls` with a signed SAML request, whose response destination is Daikin's `/adfs/saml/postResponse`. Your password is entered only on NTU's page; our app does not handle NTU credentials or SAML assertions.

1. Click **Sign in with NTU** in the demo. Finish sign-in in the new tab.
2. Daikin may show `Cannot GET /adfs/saml/redirect/...`. This is the app's return address, not necessarily a login failure. Copy the **full address from the browser bar** and paste it **only into the local demo**, then click **Connect securely**. The server accepts that exact path on the HTTPS Daikin CMS origin, extracts its code, and POSTs it as `hash` to the fixed Daikin `/auth/ad/callback` endpoint. The returned `data.token` is kept in memory. The URL itself is never fetched. Existing raw bearer tokens still work; direct-token URLs support a single `token`, `access_token`, or `bearer_token` parameter on the exact approved Daikin origins.
3. The backend verifies the token against Daikin's `/me` endpoint before enabling controls. Try **Turn off** while present in the room and check both the reported state and the unit.

The redirect-path login exchange was verified with the user's own account on 7 October 2026, followed by a successful off command and a later `/me` response reporting power off. Authentication endpoint and callback prefix were also found in the Hall Aircon Android app's code. No downloaded app code was executed. The direct-token query names remain compatibility options; the observed real flow uses a login code in the path. Automatic redirect to the local app is not implemented; Daikin's SAML response destination is fixed. Never paste your NTU password or SSO cookies, and never send login codes, tokens or completed login URLs in chat.

The app sends power and target-temperature commands to `/v2/ac/control`, then queries `/me` to check the reported state. Temperature changes require the aircon to be on, preserve the shutdown timer, and use a fresh power check before sending. The demo accepts whole-number targets from 22 to 30°C; these are demo guardrails, not verified limits for every NTU controller. Daikin may reject a narrower range. The app does not change billing, payments, or room assignment.

The public reference describes obtaining a token from traffic of your own authenticated app: https://github.com/GitHub-OfficialAccount/hall-aircon . This may require advanced tooling; no traffic interception, root certificate installation, or NTU password collection is automated by this demo. Token lifetime and revocation still need verification. No OAuth client registration or permission to change Daikin's SAML configuration has been assumed.

**Live authentication and power-off were verified for one account.** Other accounts and controller models, overnight timer reliability, token lifetime and revocation still need verification. Daikin's response confirms reported service state, not independently measured physical or billing state. First check status, then use an explicit on/off action while present in the room. The controller is asynchronous: after sending a command, the app checks reported status again up to four times at 1.5-second intervals. Test a 1-minute shutdown while awake before using it overnight.

## Security and local limitations

- The server binds to `127.0.0.1` only, validates Host, rejects cross-site requests, and requires exact Origin plus an unpredictable CSRF token on all writes.
- Session identifiers use 256-bit randomness, HTTP-only SameSite=Strict cookies and a 30-day absolute local expiry. The loopback HTTP cookie lacks Secure; remote hosting requires HTTPS, Secure cookies and a separate production authentication review.
- Remembered Daikin credentials and timers are encrypted in private local user storage outside this repository. Unremembered connections remain in memory. Disconnect removes the saved connection and timer. See AUTOMATIC-LOGIN.md for key protection and its limits; upstream revocation is not implemented.
- Response data is reduced to aircon power, room temperature, target temperature and timestamps. Raw upstream errors, names, matric numbers and addresses are never sent to the browser. A token may grant broader access upstream than the two endpoints used here.
- CSP blocks third-party scripts, remote connections from the UI, framing and inline code. No external fonts, analytics or CDNs.
- Basic rate limits, input limits, request timeouts, upstream redirect rejection and per-session operation serialization protect the local endpoints. This is a personal demo, not a security-audited public service.
- Timers run on this computer, not your iPhone. Keep the computer awake, online and the process running. Closing the browser is fine. Remembered timers survive restarts; jobs over two minutes late are marked failed. Up to three shutdown attempts occur with 15-second retry delays; failures appear in the UI. Cancelled/completed jobs do not keep running. Any manual power action cancels the current schedule.
- Disconnecting or letting your session expire does **not** automatically turn the aircon off. Do so explicitly before disconnecting if required.
- iPhone access over Wi-Fi is intentionally unavailable on the loopback demo. Later hosting will provide HTTPS access without exposing this development server.

## Verification

```sh
npm test
```

Tests exercise the HTTP handler directly with a fake Daikin transport and accelerated clock, without opening network sockets. They do not connect to or control a real aircon. Browser WebMCP read support is optional and requires a supporting browser; it is not part of authentication.

## Cloudflare deployment

A personal Cloudflare Worker with SQLite-backed Durable Object alarms is included. See [Free hosting setup](CLOUDFLARE.md). The local `npm start` flow remains available. Cloudflare deployment still requires a Worker build check and live login/timer verification; local tests do not control equipment.
