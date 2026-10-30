---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# Surface: main app (public/index.html)

Mode: Operate. Audience: the owner, on iPhone at night and laptop by day. Job: switch on, set a sleep timer, check cost. Constraints: not dense, not bright at night, plain HTML/CSS/JS, strict CSP, existing element IDs kept.

## Direction contract

THESIS: The category standard played straight: a smart-home thermostat app at Apple Home polish. Refuses decoration (ambient blobs, glass, glow) and the old single long page with history hidden in a fold.

OWN-WORLD: Near-black blue ground (#0b0f17), raised surfaces #161c28 with 20px radii, soft offset shadows, white text, slate secondary text. Cooling blue (#3b82f6 family) for the dial arc, power and selection; Saver rest in muted indigo; amber only for practice and pending; red only for failure. System sans, tabular numerals, 1.2 type scale.

STORY: Opening the app shows the room temperature and power at once, the sleep timer right under it, and Saver beside. Money lives one tab away under Usage, with balance always shown.

FIRST VIEWPORT: Phone: large title "Aircon" with mode pill and settings; a 240px circular dial (arc = target within 22–30, room temperature centred, state text); − power + row below; Sleep timer card with chips; Saver row; bottom tab bar Control / Usage. Laptop: dial column left, timer and Saver right, tabs as a segmented control in the header.

FORM: Category standard (canon), chosen by the user. seed:ae1fa9c465afcb80. Signature interaction: the dial arc sweeps to the new target as you tap − / +, and its colour shifts with state (cooling blue, resting indigo, off grey).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
