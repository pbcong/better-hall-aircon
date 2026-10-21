# App UX and reliability revision plan

Investigated 12 October 2026. The implementation is now complete; the sections below retain the original investigation and intended design. Existing uncommitted application changes were preserved. The original investigation passed 34 tests; the completed revision passes 44 tests. Tests use fake equipment, clocks and storage; the deployed configuration and real overnight shutdown behavior were not verified.

## What the current code establishes

- `cloudflare/worker.mjs` requires HTTP Basic authentication (`owner` plus a password of at least 20 characters) for every asset and API request. This is the app's password gate, not a requirement to sign into the Cloudflare dashboard. Browser credential retention controls how often its native prompt returns. A separate Cloudflare Access policy, if configured in the dashboard, would be another gate; no such configuration is visible in this repository.
- `server.mjs` creates a persistent 30-day browser cookie. Cloud connections and timers are encrypted in Durable Object storage, and storage writes schedule alarms transactionally. The cloud tests cover restoration after object eviction and execution without a browser request.
- Refreshing with the same valid cookie should restore the timer. Closing the tab or switching off the computer should not stop a hosted timer. The local Node version needs an awake computer and running server.
- Connections and timers belong to browser sessions, despite all sessions using one personal Durable Object. A different browser, private browsing, missing cookie or expired session creates an empty connection. An older session's timer may still exist and execute, even though the new session cannot see it. Independently connected sessions can schedule conflicting commands for the same room.
- Timer input supports only whole minutes, from 1 to 480. The server already stores an absolute `dueAt`, so a clock-time input can reuse the alarm mechanism.
- Both manual power buttons clear the timer before attempting the command, including Turn on and failed commands. Disconnect and successful reconnection also clear it. An upstream 401 during a normal status/control request forgets the connection and timer; an upstream 401 during an alarm marks the timer failed and disconnects.
- Shutdown attempts are bounded to three, with 15-second retry delays. Jobs more than two minutes overdue fail without sending an off command. An unconfirmed command does not count as confirmed shutdown. Browser-session expiry deletes its connection and timer; scheduling beyond that expiry is rejected.
- The UI hides all controls, including the timer result, when disconnected. Consequently some shutdown failures are reduced to a notice while their schedule details disappear.
- API code always parses JSON, so a non-JSON authentication or infrastructure response can produce an unhelpful parsing error. Polling runs every three seconds, even in a hidden tab; there is no immediate foreground recovery. Cached Daikin state can look current unless the last-checked timestamp is read.
- Persistence failure returns an error, but the in-memory mutation is not rolled back. A later read can display a schedule that was not durably accepted. The fake cloud transaction does not model real rollback, and that test coverage needs improvement.

## Intended experience

Open the app on a trusted phone and see the room, its connection health and any active shutdown immediately. Pick **After a duration** or **At a time**. Before saving, see an unambiguous preview such as “Tomorrow, 7:00 AM · Singapore time · in 9 hours.” After the server saves it, see “Saved in cloud — you can close this page.” Returning on another authorized device shows the same schedule and its outcome.

### 1. Remember app access

Replace the native Basic prompt with an app sign-in page and an opaque, revocable server-side login session. Keep the existing strong access password as a one-time login/recovery credential, support password-manager autofill, and default to remembering a trusted device for 30 days. Use Secure, HttpOnly cookies, retain CSRF and origin checks, rate-limit password attempts, and offer explicit device logout/revocation. Never store the password or Daikin token in browser local storage.

This removes repeated typing without opening equipment controls to everyone with the URL. A passkey is a useful later addition, rather than a dependency for the first revision. NTU/Daikin authentication remains separate: retain its encrypted token and ask for NTU sign-in only when it is rejected. No verified token-refresh mechanism currently exists.

If the live site also uses Cloudflare Access, inspect its application/policy session settings and choose a single coherent access flow. Do not blindly remove both gates. Dashboard login is needed for administration, not everyday equipment control.

### 2. Store the room independently of device logins

Introduce one persistent owner/room record containing the Daikin connection, active shutdown and recent outcome. Browser login sessions authorize access to that record; their expiry or logout must not cancel a scheduled shutdown. Keep practice state separate from live equipment.

Add a versioned migration for existing encrypted session records. Preserve a single eligible live connection and schedule. If there are conflicting connections or schedules, surface the conflict for resolution rather than guessing or issuing equipment commands during migration. Persist the selected room and alarm atomically.

Separate **Log out of this device**, **Cancel shutdown**, and **Remove aircon connection**. Removing a connection with a pending shutdown needs an explicit explanation and confirmation because it prevents execution.

### 3. Add clock-time shutdown

Provide two accessible choices: **After** with duration presets/custom minutes, and **At** with a native time picker. Default the room timezone to `Asia/Singapore`, regardless of the phone timezone. Choose the next occurrence of the selected time and show Today/Tomorrow plus date, timezone and remaining duration before submission. Offer a date adjustment when needed.

Accept exactly one scheduling input: duration or an absolute timestamp. Validate it server-side against server time; reject ambiguous, invalid or past timestamps. Use a proposed 24-hour maximum for both modes so next-morning schedules work consistently. Store an absolute timestamp and the display timezone, with the same backend job path for either input.

Show the active schedule prominently, with **Change** and **Cancel**. Replacement should leave the old schedule intact until the new one is durably saved. Setting a shutdown does not turn equipment on.

### 4. Make outcomes and cancellation explicit

Preserve the shutdown when pressing Turn on or changing temperature. A confirmed manual Turn off can resolve the schedule as manually completed; a failed/unconfirmed command must retain it. Reauthentication for the same room should not silently discard the schedule.

Keep scheduled, executing/retrying, confirmed, failed and cancelled outcomes visible independently of connection health. Explain token expiry, storage failure, delayed execution and lack of confirmation distinctly. On token rejection, retain the failed job/outcome and ask for reconnection; do not silently erase it or execute a stale job after reconnection.

Retain bounded retries and a clearly stated two-minute lateness window initially. Add job identity/version checks so retries or restored alarms cannot act on a replaced job. Treat storage commit as the acceptance boundary: never display “Saved in cloud” from an uncommitted in-memory change. Restore memory or reload committed state following a failed write.

### 5. Improve page recovery and language

Handle authentication expiry and non-JSON errors cleanly. Fetch state immediately on foreground/online events, reduce hidden-tab polling, prevent overlapping reads, and distinguish browser connectivity from Daikin connection health. Show stale reported equipment status clearly; foreground restoration may request a bounded fresh status check.

Replace hosted “Local demo” and local-only wording with explicit hosting information rather than fragile string replacements. Keep hosted sign-in steps short, put advanced raw-token input under details, and show “Cloud shutdown” near the active schedule. Keep failures visible near the schedule instead of only in a transient global notice. Check mobile layout, keyboard use, accessible toggle state and live announcements.

## Implementation order and acceptance checks

1. Add persistent room state, versioned migration and atomic schedule acceptance. Verify missing/new cookies and two authorized devices show the same room; logout/session expiry cannot erase its timer. Test conflicting legacy records and realistic transaction rollback.
2. Add remembered app login and device logout/revocation; remove Basic authentication only after the replacement is effective. Verify unauthenticated commands remain blocked, login is rate-limited, and credentials never enter browser storage or diagnostic output.
3. Add After/At inputs and server validation. Cover midnight rollover, Today/Tomorrow, a phone in another timezone, past/equal timestamps, limits and schedule replacement failure.
4. Revise cancellation, reconnection and outcome visibility. Cover failed Turn on/off, token expiry, unchanged temperature timers, retries, duplicate alarm delivery and jobs outside the lateness window.
5. Check page recovery on refresh, foreground, offline/online and expired login, then perform a deployment build check.
6. After deployment, verify a short practice alarm with the page closed. Separately verify a short real shutdown while present in the room, checking reported and physical state, with the browser closed and computer off. Then verify a clock-time shutdown across midnight. Local tests alone cannot establish live Daikin connectivity or deployed alarm reliability.

Cloudflare documents durable alarm execution and automatic retries, but this does not guarantee successful Daikin commands or exact timing: https://developers.cloudflare.com/durable-objects/api/alarms/

If a separate Access gate exists, its session durations are configured independently: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/

## Implementation result (12 October 2026)

Implemented remembered device login, one cloud room independent of device sessions, encrypted v2 migration with explicit conflict selection, duration/clock scheduling up to 24 hours, atomic acceptance and rollback, explicit removal confirmation, preserved timers on Turn on/failed off, retained failure outcomes, foreground recovery and mobile UI updates. The strong existing password is now used for occasional app sign-in; passkeys remain a later option. No upstream token-refresh API was assumed.

The local Node test suite and Worker build pass. A real local workerd/SQLite browser smoke test passed login, reload, logout/re-login, mobile layout, confirmation dialogs and an autonomous practice alarm with the page closed. Supervised real equipment shutdown and overnight behavior still require a room check; these cannot be established with practice mode.

Published to the existing Worker on 12 October 2026. Live verification confirmed the new sign-in shell and assets, removal of the Basic prompt, and rejection of unauthenticated room reads and timer writes. No real equipment commands were sent during this implementation.
