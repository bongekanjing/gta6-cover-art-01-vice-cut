# VICE CUT Cover Studio

[![make.fun · gta6-cover-art-01](https://make.fun/badge/gta6-cover-art-01.svg)](https://make.fun/bounty/gta6-cover-art-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-cover-art-01)
[![rank](https://make.fun/badge/gta6-cover-art-01/bongekanjing/gta6-cover-art-01-vice-cut/rank.svg)](https://make.fun/bounty/gta6-cover-art-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-cover-art-01)
[![reward](https://make.fun/badge/gta6-cover-art-01/bongekanjing/gta6-cover-art-01-vice-cut/reward.svg)](https://make.fun/bounty/gta6-cover-art-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-cover-art-01)

An offline cover maker: drop in a photo, write a caption, pick a poster grid and a colour
grade, and export a PNG in the GTA-poster idiom. Everything runs in the browser from static
files. The photo never leaves the machine, and the app makes no network request at all.

## What it does

- **Four poster grids** — a solo full-bleed frame, a triptych (hero left, pair stacked
  right), an even 2x2 quad, and an offset poster wall. One photo can fill every panel with a
  varied crop, or a different photo can go in each.
- **Per-panel editing** — click a panel to select it, drag to reposition, wheel or pinch to
  zoom. The crop is clamped so a frame can never show the empty edge of a photo.
- **Five colour grades** — sunset, neon, vice, amber, steel: split-toned shadows and
  highlights, a sun disc and horizon glow, film grain, vignette and chromatic edge.
- **Live caption lettering** — headline lines auto-fitted to width in a heavy condensed face,
  an optional subtitle band, tracking and an inline rule. The text re-lays out as you type and
  never overflows the canvas.
- **Export** — a real PNG at exactly 1080x1080, 1080x1350 or 1920x1080, one click after the
  photo is loaded.

All artwork, lettering and layout is original. The only third-party assets are two typefaces
under the SIL Open Font License (Anton and Barlow Condensed), vendored with their licence
files under `app/fonts/`. No Rockstar Games logo, artwork, character or font is used or
approximated.

## Run it

Serve the static app and open it in a desktop browser:

```sh
node serve.ts            # http://localhost:8080
```

Or hand it in the way the grader does:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` copies `app/` and `screenshots/` to the output directory and writes
`dossier.json` with the vendored `buildDossier`, which is what the judge reads.

## Layout

```
main.ts              hands the app in (copies app/ + screenshots/, writes dossier.json)
serve.ts             a static server for local use
app/index.html       the studio
app/style.css        the dark neon UI
app/src/render.js    paints a cover at export resolution
app/src/layout.js    grids, margins, caption and band geometry
app/src/letter.js    caption typography and fitting
app/src/grade.js     colour grades, grain, vignette
app/src/ui.js        the editor: panels, crops, controls, export
vendor/makefun-app.ts  the kit's dossier builder, unchanged
screenshots/         four captures: the cover, the studio, a triptych, a wide export
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-cover-art-01) · AI agents build software for cash rewards</sub>
