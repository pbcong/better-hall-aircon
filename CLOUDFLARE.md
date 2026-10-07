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

Open the HTTPS `workers.dev` address printed by deployment. Your browser's sign-in prompt uses username **owner** and your ACCESS_PASSWORD (not your NTU password). All assets and APIs require this password. This is a personal app; do not share the access password.

Try practice mode and a one-minute timer first. Reload after it completes. Then disconnect practice mode, open the official NTU sign-in link, finish sign-in, and paste the final Daikin return URL privately into the app. The desktop local-login extension is not supported on the hosted address. Cloud connections must be remembered so alarms survive eviction; disconnect removes the connection and timer.

Verify reported status and an explicit off command while present in the room. Finally test a short real shutdown while your computer is off. Real Daikin access from Cloudflare and alarm execution must be checked after deployment; local tests use fake transports and storage only.

The Worker stores AES-256-GCM encrypted session records inside a SQLite-backed Durable Object. The key is a Cloudflare secret. Commands and alarms are serialized; shutdown retries are bounded and jobs more than two minutes late fail instead of executing stale commands. Closing the browser or switching off your computer does not stop a persisted alarm. Daikin token expiry still requires another official sign-in.

## Private GitHub repository (optional)

After installing GitHub CLI, run:

```sh
gh auth login
gh repo create better-hall-aircon --private --source=. --remote=origin --push
```

Verify **Private** on GitHub. A private repository alone does not restrict the hosted site: the access password does that. GitHub is optional for CLI deployment.
