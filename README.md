# Slidesv

Zero-dependency SVG-based presentation engine and compiler in TypeScript.

## Features

- **Live Auto-Parsing (`index.html`)**: Drop `index.html` into any folder of `.svg` files and serve over HTTP with automatic 500ms polling hot-reload.
- **Single-File Bundler (`cli.ts build`)**: Compiles into a standalone, offline-ready `dist/presentation.html` with Base64-embedded fonts and optional `--pdf` export.
- **Shared Core (`src/core/`)**: Filename selector grammar (`n`, `n_m`, `,`, `!`), z-index bands (`underlay`, `normal`, `overlay`), progressive `-step_<k>`, transitions (`-t_<effect>`), radio groups (`-g_<group>`), hotkeys (`-s_<mod>_<key>`), SVG ID/SMIL namespacing, and dynamic tokens (`{{INDEX}}`, `{{TOTAL}}`, `{{TITLE}}`, `{{PROGRESS}}`, `{{DATE}}`).
- **Dual-Mode Translations**: File-level `-lang_<codes>` layers and native SVG `<switch>` (`systemLanguage`) synchronized with Slide 0, HUD, and `?language=`.
- **Stage & Presenter Tools**: Slide 0 Control Hub, `BroadcastChannel` Presenter View (`P`), Virtual Laser (`L`), Freehand Drawing (`D`/`C`), Overview Grid (`G`/`Esc`), and HUD toggle (`H`).

## Usage

```bash
# Run tests
npm test

# Build standalone live index.html
npm run build:index

# Serve demo-deck in live mode
node cli.ts serve demo-deck --port 3000

# Build single-file presentation
node cli.ts build demo-deck --out demo-deck/dist/presentation.html
```
