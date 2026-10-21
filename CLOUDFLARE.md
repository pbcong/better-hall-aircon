# Free personal Cloudflare hosting

Use **Workers Free**, SQLite-backed Durable Objects, and the included `workers.dev` address. Do not upgrade your Workers plan, buy a domain, or enable paid services. Free quotas reject operations rather than charging overages. Quota exhaustion can prevent shutdowns; this is not a guarantee of uninterrupted aircon control. Aircon usage charges are separate.

## Deploy from a terminal on your computer

Requires Node.js 22+ and your free Cloudflare account. Run in this project directory:

```sh
npm install
npm test
npx wrangler login
npm run cloud:check
npm run cloud:deploy
```

The initial deployment remains locked with HTTP 503 until both secrets are configured. `wrangler login` opens the official Cloudflare login; do not share tokens in chat.

Generate a private access password with your password manager (at least 20 characters). Set it using the hidden prompt:

```sh
npx wrangler secret put ACCESS_PASSWORD
```

Generate a 32-byte hexadecimal encryption key on your own computer:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save the generated key in your password manager, then paste it into this hidden prompt:

```sh
npx wrangler secret put ENCRYPTION_KEY
```

Never commit either secret. Losing or changing the encryption key makes existing saved connections unreadable. Ordinary Worker secrets are used; no paid Secrets Store is required.

## Connect and verify

Open the HTTPS `workers.dev` address printed by deployment. The app shows a sign-in form for your ACCESS_PASSWORD (not your NTU password). **Remember this device** is selected by default and keeps you signed in until 30 days after your last visit (renewed at most once a day). You do not need to sign into the Cloudflare dashboard to use the app. The static sign-in page is public; room data and every equipment command require an authenticated device. Passwords and Daikin tokens are never stored in browser local storage. This is a personal app; do not share the access password.

Try practice mode and a one-minute timer first. Reload after it completes. Then disconnect practice mode, open the official NTU sign-in link, finish sign-in, and paste the final Daikin return URL privately into the app. The desktop local-login extension is not supported on the hosted address. Cloud connections are always saved, so alarms survive eviction. Every signed-in device sees the same room and shutdown. Device logout and login expiry keep the shutdown running. **Remove connection** explains and confirms cancellation of any pending shutdown; it does not turn the equipment off.

Verify reported status and an explicit off command while present in the room. Finally test a short real shutdown while your computer is off. Real Daikin access from Cloudflare and alarm execution must be checked after deployment; local tests use fake transports and storage only.

The Worker stores AES-256-GCM encrypted room records, device credential hashes and sign-in rate limits inside a SQLite-backed Durable Object. The key is a Cloudflare secret. Commands and alarms are serialized; shutdown retries are bounded and jobs more than two minutes late fail instead of executing stale commands. Closing the browser or switching off your computer does not stop a persisted alarm. Daikin token expiry still requires another official sign-in.

## Private GitHub repository (optional)

After installing GitHub CLI, run:

```sh
gh auth login
gh repo create better-hall-aircon --private --source=. --remote=origin --push
```

Verify **Private** on GitHub. A private repository alone does not restrict the hosted site: the access password does that. GitHub is optional for CLI deployment.

## Scheduling and returning to the app

Choose **After a duration** (1–1440 minutes) or **At a time**. Clock times always use Singapore time, even if your phone is in another timezone. The time picker defaults to the next occurrence and previews Today/Tomorrow; you can adjust the date within the next 24 hours. Saving replaces the existing shutdown only after the cloud commit succeeds.

Turn on and temperature changes preserve the shutdown. A confirmed manual Turn off resolves it; an unconfirmed or failed off retains it. **Cancel timer** records a cancelled outcome. Failed shutdown details remain visible after Daikin sign-in expires. Reconnecting retains that failed outcome and does not execute it later.

Old encrypted browser-session records are migrated without changing ENCRYPTION_KEY. A single eligible connection is retained automatically. If multiple connections were saved, the signed-in owner chooses one in the app; the choice explicitly removes the other saved connections and schedules. Until then, old pending jobs remain eligible to run under their original expiry rules.

Use **Log out of this device** to revoke only its access or **Log out all devices** to revoke every device. Changing ACCESS_PASSWORD invalidates existing device logins on their next request without removing the room connection or timer. An optional Cloudflare Access gate configured outside this repo has its own session duration and may still request sign-in; inspect that dashboard policy separately.

## Validation status

The revision passes 44 automated tests with fake Daikin responses and storage failures, plus a browser smoke check using real local workerd/SQLite. The build check does not deploy or operate equipment. Live Daikin access, short cloud shutdown with the browser/computer off, and a clock-time shutdown across midnight still need a supervised equipment check.

For the optional local browser/runtime smoke check (requires Chromium; set AIRCON_CHROME_PATH if its location differs from the script default):

```sh
npm run cloud:check -- --outdir /tmp/hall-aircon-build
node test/browser-smoke.mjs
```

This starts an isolated local Cloudflare runtime with SQLite and test-only app credentials. It verifies login, reload, logout, mobile layout, confirmation dialogs and a practice alarm after page closure; it never sends real Daikin commands.

Deployed on 12 October 2026 at https://better-hall-aircon.pbcong.workers.dev. The live shell serves the revised sign-in and scheduling assets without Basic authentication, and unauthenticated room reads and timer writes are rejected. A signed-in real equipment check still requires the owner in the room.
