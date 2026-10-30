# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner, an NTU hall resident controlling the Daikin aircon in their own room. They use it about equally on an iPhone (added to the home screen) and a laptop. Not shared with roommates or other residents.

## Product Purpose

A better remote for a pay-per-minute hall aircon. It switches the aircon on and off, sets the target temperature, shuts it off on a schedule (sleep timer), runs Saver cycles to cut billed minutes, and shows what cooling has cost. Success: the room stays comfortable while the owner pays for fewer minutes and never wakes up to an aircon that ran all night.

## Positioning

The official Hall Aircon app only switches the unit. This app adds the things that save money and sleep: a shutdown timer that runs in the cloud, Saver cycling, and an honest cost history built from logged readings.

## Operating Context

- Hall aircon is billed for time switched on (about $0.36–0.40/h), deducted from a Daikin wallet when the unit switches off.
- Typical uses: switch on before or on arriving in the room, set a sleep timer at bedtime, check balance and spend now and then.
- Two deployments: a local Node server (127.0.0.1) and a personal Cloudflare Worker reachable from the phone. Both serve the same `public/` UI.
- Sign-in is NTU SSO via Daikin; the app never sees the NTU password. A practice mode exists for trying controls without equipment.
- The Daikin controller is asynchronous: commands are confirmed by re-reading status, so state can be pending or stale.

## Capabilities and Constraints

- Power on/off, target 22–30 °C (whole degrees, only while on), Saver switch plus Saver schedule (fixed intervals or room temperature), sleep timer (quick presets, duration, or clock time in Singapore time, up to 24 h), usage history with charts, tables and CSV export, settings (quick timers, connection, device logout).
- Shows which account's wallet is paying.
- Strict CSP: no inline scripts or styles from elsewhere, no external fonts, CDNs or analytics. Any font must be self-hosted or a system font.
- Plain HTML/CSS/JS modules in `public/`, no build step or framework.
- Existing element IDs are used by `public/app.js`, `public/usage.js` and `test/browser-smoke.mjs`.

## Brand Commitments

Name: "Aircon" (home-screen title), page title "Hall Aircon". Footer must keep: independent student project, not affiliated with NTU or Daikin.

Standing preference (chosen 2026-10-30): the familiar smart-home thermostat look, executed at the polish of Apple Home. Convention over novelty. Dark screen, since a light one glares in a dark room at night.

## Evidence on Hand

Real data comes only from the owner's own logged readings and Daikin's `/me` response. No testimonials, users or claims beyond that.

## Product Principles

1. State first: power, room temperature, and any pending shutdown must be readable at a glance, including whether the reading is fresh.
2. Money is visible: the app exists to save money, so cost and balance should never be buried.
3. Never surprise the equipment: commands are explicit, confirmed, and failures stay visible until resolved.
4. Works half-asleep: the bedtime path (on, timer, done) takes a few taps on a phone in a dark room.

## Accessibility & Inclusion

No specific requirement beyond good practice: keyboard use on laptop, screen-reader live announcements for state changes, reduced motion respected.
