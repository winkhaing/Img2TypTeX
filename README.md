# Img2TypTeX

Snip a math equation anywhere on screen, OCR it with Claude's vision model, and get ready-to-paste [Typst](https://typst.app) math markup on your clipboard. Same workflow as Mathpix's snipping tool, targeting Typst instead of LaTeX.

## How it works

1. Press **Alt+Shift+M** (or click the tray icon) to open a full-screen snip overlay, **or** choose **Open Image File…** from the tray menu to OCR an equation from an existing image file (PNG, JPEG, GIF, WebP, BMP) instead of the live screen.
2. If snipping, drag a rectangle around an equation anywhere on screen — any app, any window.
3. The image (captured region or uploaded file) is sent to Claude's vision API and OCR'd to LaTeX.
4. The LaTeX is converted to Typst markup locally and shown in a result window with **Copy Typst** and **Copy LaTeX** buttons.

Press **Esc** or click without dragging to cancel a snip.

## Project structure

```
Img2TypTeX/
├── src/                      # Frontend (plain HTML/CSS/JS, no bundler)
│   ├── overlay.html          # Full-screen drag-to-select snip surface
│   ├── result.html           # Shows the OCR'd Typst + LaTeX, with copy buttons
│   ├── settings.html         # API key / model configuration
│   ├── style.css             # Shared dark theme for result + settings
│   └── lib/
│       ├── converter.js      # LaTeX -> Typst transpiler
│       └── converter.test.js
├── src-tauri/                # Rust backend (Tauri v2)
│   ├── src/
│   │   ├── lib.rs            # Tray icon, shortcut, windows, Tauri commands
│   │   ├── capture.rs        # Screen-region capture (xcap) -> PNG
│   │   ├── ocr.rs            # Calls the Anthropic Messages API (vision)
│   │   ├── config.rs         # Local JSON config (API key, model)
│   │   └── main.rs
│   ├── capabilities/default.json
│   └── tauri.conf.json
└── package.json
```

The frontend intentionally has no build step: it loads `window.__TAURI__.*`
globals directly (`withGlobalTauri: true` in `tauri.conf.json`), so there's
nothing to bundle and no JS dependencies to install.

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Node.js](https://nodejs.org/) 18+ (only used to run the Tauri CLI)
- Platform build tools required by Tauri — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for your OS (Xcode command line tools on macOS, WebView2 on Windows, `webkit2gtk`/`libsoup` etc. on Linux)
- An [Anthropic API key](https://console.anthropic.com/) with access to a vision-capable Claude model

## Setup

```bash
npm install
npm run dev
```

This launches the app in development mode. On first run, open **Settings**
from the tray menu and paste in your Anthropic API key (and optionally
change the model — defaults to `claude-sonnet-4-6`). The key is stored
in a local JSON file in the OS-standard app config directory and is never
sent anywhere except directly to Anthropic's API.

## Building

```bash
npm run build
```

Produces a native installer/bundle for your current platform (`.dmg`/`.app`
on macOS, `.msi`/`.exe` on Windows, `.deb`/`.AppImage`/`.rpm` on Linux) in
`src-tauri/target/release/bundle/`.

## Configuration

| Setting | Where | Notes |
|---|---|---|
| Anthropic API key | Settings window | Required before snipping will work |
| Model | Settings window | Any vision-capable Claude model id, e.g. `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` |
| Global shortcut | `src-tauri/src/lib.rs` (`SNIP_SHORTCUT`) | Currently hard-coded to `Alt+Shift+M`; change and rebuild to customize |

## Notes & known limitations

- The LaTeX → Typst converter (`src/lib/converter.js`) is a best-effort
  syntactic transpiler covering the symbols and structures (fractions,
  roots, sub/superscripts, Greek letters, matrices, cases, decorations,
  etc.) that show up in the overwhelming majority of OCR'd equations — it
  is not a full LaTeX parser, so unusual or malformed input may not convert
  perfectly. Run `npm run test:converter` to exercise its test suite.
- On Linux, the tray icon may not appear unless a tray menu is attached
  (this app always attaches one, so it should show up), and tray click
  events are not emitted on some Linux desktop environments — the right-click
  context menu (Snip / Settings / Quit) always works as a fallback.
- Screen capture, global shortcuts, and the tray icon all require OS-level
  permissions on some platforms (e.g. Screen Recording permission on
  macOS) — grant these when prompted, or the snip will fail silently.
