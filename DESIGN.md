---
name: Aircon
description: A dark smart-home thermostat for a pay-per-minute hall aircon, at Apple Home polish.
colors:
  night-ground: "#0b0f17"
  surface: "#161c28"
  raised: "#1d2433"
  fill: "#232b3b"
  fill-hover: "#2c3547"
  text: "#f5f7fb"
  muted: "#9ba7ba"
  faint: "#7c889b"
  hairline: "rgb(255 255 255 / .08)"
  accent: "#2563eb"
  accent-hover: "#1d4ed8"
  accent-text: "#79acff"
  cool: "#4f9cff"
  rest: "#8b7cf6"
  rest-text: "#b2a8fa"
  rest-deep: "#6b5ce0"
  off: "#364055"
  green: "#30c77b"
  amber: "#f5a524"
  red: "#ff8a8a"
  band: "rgb(79 156 255 / .14)"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "76px"
    fontWeight: 300
    lineHeight: 1
    letterSpacing: "-.04em"
    fontFeature: "tnum"
  numeral-large:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "48px"
    fontWeight: 300
    lineHeight: 1.1
    letterSpacing: "-.035em"
    fontFeature: "tnum"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-.03em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-.015em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  fine:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  segment: "9px"
  control: "14px"
  inset: "16px"
  card: "24px"
  card-phone: "22px"
  sheet: "26px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  card: "22px"
  lg: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "12px 18px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "12px 18px"
    height: "48px"
  button-secondary-hover:
    backgroundColor: "{colors.fill-hover}"
  button-secondary-small:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "7px 16px"
    height: "38px"
  button-text:
    textColor: "{colors.accent-text}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "40px"
  button-round:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    size: "52px"
  power-off:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    size: "76px"
  power-on:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    size: "76px"
  power-rest:
    backgroundColor: "{colors.rest-deep}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    size: "76px"
  switch-off:
    backgroundColor: "{colors.fill-hover}"
    rounded: "{rounded.pill}"
    width: "51px"
    height: "31px"
  switch-on:
    backgroundColor: "{colors.green}"
    rounded: "{rounded.pill}"
    width: "51px"
    height: "31px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "22px"
  chip:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 2px"
    height: "52px"
  chip-selected:
    backgroundColor: "{colors.text}"
    textColor: "{colors.night-ground}"
  input:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "12px 14px"
    height: "48px"
  status-pill:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0 12px 0 10px"
    height: "32px"
  tabs:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "3px"
  tab-selected:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "6px 18px"
    height: "38px"
---

# Design System: Aircon

## Overview

**Creative North Star: "The Night-Table Thermostat"**

Aircon is the smart-home thermostat played straight, at Apple Home polish: a near-black blue room, solid raised cards, one circular dial, and type set in the platform's own sans. It is convention on purpose. The app should feel like a control that came with the phone, picked up half-asleep in a dark room, read at a glance, and put down.

The screen is dark only. There is no light theme and there should never be one: the app is used at bedtime in an unlit room, where a light surface glares. Density stays low. Each card holds one job (climate, sleep timer, Saver, usage), and the most important number on each card is set large and light.

Colour does not decorate. Surfaces are neutral blue-greys; hue appears only when it says something about the equipment: cool blue while cooling, indigo while Saver rests, grey while off, amber for practice, pending or stale, red for failure, iOS green for an "on" switch and for money saved. No glass on surfaces, no glow, no bounce.

**Key Characteristics:**
- Dark only: near-black blue ground with solid tonal cards on top.
- One circular dial as the signature: the arc sweeps to the target and changes hue with state.
- Colour carries state only; neutral everywhere else.
- System sans (SF on Apple devices) with tabular numerals; big readings in light weight.
- Generous radii (24px cards, full-round controls) and soft ambient shadows.
- iOS motion grammar: a fast-out ease, small press shrink, no overshoot.

## Colors

A cool near-black neutral ramp with a small set of state hues that never appear without meaning.

### Primary
- **Action Blue** (accent): the solid fill for primary buttons and for the power button while the unit is on. White text on it. Its hover is **Deep Action Blue** (accent-hover).
- **Link Blue** (accent-text): the readable blue for text on dark ground: links, text buttons, the selected phone tab, a pending setpoint, the scheduled-timer state, focus outlines and the caret.

### Secondary (state hues)
- **Cooling Blue** (cool): the dial arc and power-state text while cooling, the pending ring around the power button, the room line and dots in the temperature chart, and spent-cost bars.
- **Rest Indigo** (rest): the dial arc while Saver rests. **Pale Indigo** (rest-text) is its text form for the state line; **Deep Indigo** (rest-deep) fills the power button during rest.
- **Off Slate** (off): the dial arc when the unit is off or unknown.
- **iOS Green** (green): the Saver switch when on, the live dot in the status pill, a completed timer, and saved-cost bars. It is green, not Action Blue, because the user's quality bar is Apple Home and the iOS switch convention is green.
- **Caution Amber** (amber): practice mode, a roommate's or outside wallet paying, a stale reading, Saver stopped. Tinted pills use it at 12–14% over the ground.
- **Failure Red** (red): errors only: the notice banner (red at 16% over surface, with pale red text), a failed timer, destructive actions.
- **Cooling Band** (band): Cooling Blue at 14% for "aircon on" spans behind the temperature chart.

### Neutral
- **Night Ground** (night-ground): the page, the theme colour, the well behind segmented and range controls.
- **Surface** (surface): cards, sheets, the desktop tab control.
- **Raised** (raised): insets inside a card or sheet: the custom-timer panel, grouped settings lists, the dial track.
- **Fill** (fill) and **Fill Hover** (fill-hover): control backgrounds (secondary buttons, chips, inputs, round buttons, pills) and their pointer-hover, selected-segment and off-switch tone.
- **Text** (text): primary text, near-white.
- **Muted** (muted): secondary text, labels, units.
- **Faint** (faint): placeholders, chart ticks, chevrons.
- **Hairline** (hairline): 8% white dividers, table rules, list separators.

### Named Rules
**The State-Only Colour Rule.** A hue appears only when it reports the equipment or the account: cooling, resting, off, pending, stale, failed, saved. Neutral surfaces carry everything else. If a coloured element cannot say what state it reports, it is grey.

**The Dark-Only Rule.** There is one theme and it is dark (`color-scheme: dark`). Never add a light theme or light surfaces; the app is used in a dark room at night.

**The Green Switch Rule.** On/off switches use iOS Green when on, never Action Blue. Blue is for actions and cooling; green is the platform's "enabled" signal.

## Typography

**Display Font:** System sans: -apple-system / SF Pro Text (with system-ui, Segoe UI, Roboto fallbacks)
**Body Font:** The same system sans
**Label/Mono Font:** None distinct; numerals use tabular figures

**Character:** The platform's own face, used the way Apple Home uses it: big readings in a light weight with tight tracking, headings bold and tightly tracked, labels semibold and muted. No webfonts (strict CSP; system or self-hosted only).

### Hierarchy
- **Display** (300, 76px, line-height 1, -.04em, tabular): the room temperature in the dial; 66px on phones, 60px under 380px.
- **Numeral Large** (300, 48px, 1.1, -.035em, tabular): the scheduled shutdown time.
- **Headline** (700, 40px, 1.1, -.03em): the signed-out intro title; 34px on phones. The Usage heading uses 28px / 700, the balance tile 40px / 650.
- **Title** (650, 17px, 1.3, -.015em): card headings and section headings; sheet titles step up to 22px.
- **Body** (400, 16px, 1.5): base text; paragraphs in Muted with `text-wrap: pretty`.
- **Label** (600, 14px): form labels, the dial's "Room" label, chip and tab text, timer state.
- **Fine** (400, 13px, 1.55): notes, hints, legends, tile footnotes; 12.5px for table headers and small pills; 11px for chart ticks and phone tab labels.

### Named Rules
**The Tabular Numbers Rule.** Every number that changes or lines up (temperatures, times, countdowns, money, tables, chart ticks) uses tabular figures so values never jitter.

**The Light Reading Rule.** The single most important number on a card is large and light (300), never bold. Weight is for headings and labels.

## Layout

A single centred column, max 1040px wide, padded 32px on desktop, 16px on phones and 12px under 380px, respecting safe-area insets top and bottom.

The Control panel is a two-column grid (16px gap) on desktop: the climate dial card spans both rows on the left; the sleep timer and Saver cards stack on the right. At 767px and below it collapses to one column (12px gap) in the order dial, sleep timer, Saver, so the dial and timer both fit in the first phone viewport.

The dial renders 248px wide on desktop, 220px on phones and 200px under 380px. The direction contract asked for about 240px; the phone sizes were reduced so the dial and the sleep timer card both fit in the first phone viewport.

Signed-out screens use a two-column grid on desktop (intro left, sign-in card right, 56px column gap) and a single column on phones.

The Usage tab leads with a four-tile summary strip (balance wider at 1.5fr), which on phones becomes a full-width balance tile over three equal tiles, followed by one card of charts, stats and disclosures.

Spacing rhythm is 8 / 12 / 16 / 22–24 / 32px: 8px between chips, 12–16px between cards, 22px card padding (20px phone, 18px × 16px under 380px), 24–36px under the header.

## Elevation & Depth

Depth is tonal first: Night Ground, then Surface for cards, then Raised for insets, then Fill for controls. Shadows are soft and ambient, offset downward, never hard-edged and never coloured.

### Shadow Vocabulary
- **Card** (`box-shadow: 0 1px 2px rgb(0 0 0 / .35), 0 10px 28px -12px rgb(0 0 0 / .6)`): every card and the usage tiles strip.
- **Lift** (`box-shadow: 0 24px 60px -12px rgb(0 0 0 / .75)`): sheets, alerts, the toast and chart tooltips: things floating above the page.
- **Thumb** (`box-shadow: 0 2px 6px rgb(0 0 0 / .3)`): the sliding thumb in segmented and range controls.
- **Power** (`box-shadow: 0 4px 14px -4px rgb(0 0 0 / .6)`): the power button at rest; tightened to `0 6px 16px -6px rgb(0 0 0 / .7)` when pressed on.

### Named Rules
**The Solid Surface Rule.** Cards, sheets and controls are opaque. No glass, no blur, no glow, no gradient fills on surfaces. The one exception is the phone tab bar, which uses the iOS tab-bar material (92% ground with a 20px backdrop blur) because it is that platform's native bar.

## Shapes

Generously rounded, continuous forms. Cards use 24px corners (22px on phones), sheets 26px (top corners only when they rise from the bottom on phones), alerts 22px. Buttons, inputs and chips use 14px. Grouped lists and notices use 16px; segments inside a control use 9px within a 12px well. Pills, status chips, the tab control, small buttons, switches and every circular control (round ± buttons, the power button) are fully round. Borders are rare: dividers and table rules are 1px Hairline; dialogs carry a 1px Hairline edge. Icons are stroked SVG, 2px, round caps and joins.

## Components

### Buttons
Quiet, solid and tactile: they shrink slightly on press and never bounce.
- **Shape:** gently rounded (14px), 48px minimum height.
- **Primary:** Action Blue fill, white 15px / 600 text, full width in forms; hover Deep Action Blue.
- **Secondary:** Fill background with Text; hover Fill Hover. The small variant is a 38px pill.
- **Text / Link:** Link Blue text, no fill; text buttons gain a Fill background on hover.
- **Danger:** Failure Red text on the secondary or list-row treatment.
- **Press:** scale to .96 with the iOS fast-out ease; disabled at 40% opacity. A spinner replaces the label only after a request has run 200ms.
- **Focus:** 2px Link Blue outline, 3px offset.

### Chips (sleep timer presets)
- **Style:** Fill background, 14px corners, 52px tall (48px phone), tabular 15px text, in a four-up grid plus a "Custom" chip.
- **State:** the open Custom chip inverts to Text background with Night Ground text.

### Cards / Containers
- **Corner Style:** 24px (22px phone).
- **Background:** Surface; insets inside use Raised.
- **Shadow Strategy:** Card shadow (see Elevation).
- **Border:** none.
- **Internal Padding:** 22px (20px phone).

### Inputs / Fields
- **Style:** Fill background, 1px transparent border, 14px corners, 48px tall; unit suffixes sit inside the field in Muted.
- **Focus:** border turns Action Blue with a 4px Action Blue ring at 25%.
- **Hover:** border to Fill Hover (pointer devices only).

### Navigation
- **Desktop:** a segmented pill in the header: Surface well, 3px padding, the selected tab on Fill with Text, others Muted.
- **Phone:** a fixed bottom tab bar above the home indicator: icon over an 11px / 600 label, selected tab in Link Blue with no fill. Arrow keys, Home and End move between tabs.

### Climate Dial (signature)
A circular SVG ring, a 270° track in Raised with a 14px stroke, opening at the bottom. The arc fills the share of the target within the allowed range (22–30°C) and sweeps to a new target in 450ms as − / + are tapped. Its hue reports state: Cooling Blue when on, Rest Indigo while Saver rests, Off Slate when off. The face stacks the "Room" label, the Display temperature with a Muted °C, the state line in the matching state hue, and the target. Below sits a row of a 52px round − button, the 76px power button and a 52px round + button (48 / 68px on phones). The setpoint rolls up or down in the direction it moved and shows in Link Blue while pending.

### Power Button
Fill with a Muted icon when off; Action Blue with white when on; Deep Indigo while Saver rests. While Daikin confirms a command, a 2px ring spins around it (Cooling Blue going on, Muted going off). Press shrinks to .92.

### Switch
iOS-proportioned, 51 × 31px, white 27px knob with a soft shadow. Off is Fill Hover; on is iOS Green. The knob stretches to 33px while pressed and slides with the fast-out ease.

### Pills
- **Status pill:** 32px Fill pill with a 7px dot: green dot for live, amber text and dot for practice.
- **Payer pill:** Fill and Muted for your own wallet; amber tint for a roommate's or an outside wallet.
- **Stale pill:** amber tint, tap to refresh.

### Sheets and Alerts
Sheets are Surface with 26px corners and the Lift shadow, centred on desktop and rising from the bottom edge on phones with a 36 × 5px grabber. Alerts are 320px, centred text, scale in from 1.06. The backdrop dims to 55% black.

### Segmented and Range Controls
A Night Ground well with a Fill Hover thumb that slides under the chosen option (450ms fast-out); unchosen options are Muted.

## Do's and Don'ts

### Do:
- **Do** keep every surface on the dark ramp: Night Ground, Surface, Raised, Fill.
- **Do** colour only by state: Cooling Blue cooling, Rest Indigo Saver rest, Off Slate off, Caution Amber practice / pending / stale / someone else paying, Failure Red failure.
- **Do** use iOS Green for an "on" switch and for money saved.
- **Do** use tabular numerals for every changing or aligned number.
- **Do** set the main reading on a card large and light (300 weight).
- **Do** move with the iOS ease (`cubic-bezier(.32, .72, 0, 1)`) for state changes and the fast-out ease (`cubic-bezier(.22, 1, .36, 1)`) for movement; respect reduced motion.
- **Do** confine hover styles to real pointers (`hover: hover` and `pointer: fine`).

### Don't:
- **Don't** add a light theme or light surfaces.
- **Don't** use glass, blur or translucency on cards, sheets or controls; the phone tab bar's iOS material is the only exception.
- **Don't** add glow, coloured shadows, gradients or ambient blobs.
- **Don't** use bounce or overshoot easing; presses shrink and settle.
- **Don't** colour an element that reports no state.
- **Don't** use Action Blue for switches.
- **Don't** load webfonts from elsewhere; the system sans is the face.
