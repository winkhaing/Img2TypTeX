# Img2TypTeX — Proposal by @winkhaing

## Gist
A desktop app that lets you snip any equation on screen and instantly get ready-to-paste Typst math markup — Mathpix's snipping tool, but for Typst instead of LaTeX.

## Story
Win is writing a paper/notes in Typst and hits a dense equation in a reference PDF, textbook, or slide deck. Right now that means manually retyping it symbol-by-symbol into Typst's math syntax — slow, and easy to get wrong on anything with nested fractions, matrices, or unusual symbols. With Img2TypTeX, he hits a global hotkey, drags a box around the equation, and a few seconds later has the Typst code on his clipboard, ready to paste straight into the `.typ` file he's working on.

## Why
Transcribing math notation by hand is one of the most tedious parts of writing math-heavy documents. Mathpix already solved this for LaTeX, but Typst — despite growing fast as a LaTeX alternative — has no equivalent tool. This removes that single recurring friction point entirely, turning a multi-minute manual transcription into a two-second snip.

## Why Not
- Not a full LaTeX parser — a best-effort syntactic transpiler that covers the constructs (fractions, roots, scripts, Greek letters, matrices, cases, common operators) that show up in the vast majority of real equations, not every obscure macro.
- Not training a custom OCR model — delegates the actual image-to-LaTeX recognition to Claude's vision API rather than building/hosting one from scratch.
- Not offline-capable — OCR requires a network call, so there's no offline mode in v1.
- Not a web app — built as a native desktop app specifically so it can register a global hotkey and capture the screen across any other application, which a browser tab can't do.

## Tech Spec
**Stack:** Tauri v2 (Rust backend, plain HTML/CSS/JS frontend with no bundler — uses `window.__TAURI__` globals directly).

**Main pieces:**
1. **Trigger** — a global shortcut (`Alt+Shift+M`) or tray icon opens a full-screen transparent overlay on the active monitor for drag-to-select.
2. **Capture** (`capture.rs`) — grabs the selected screen region via `xcap`, encodes it as base64 PNG.
3. **OCR** (`ocr.rs`) — sends the image to Claude's vision API (Messages API) and gets back LaTeX.
4. **Convert** (`converter.js`) — a hand-written, unit-tested LaTeX→Typst transpiler turns the OCR'd LaTeX into Typst math markup, entirely client-side.
5. **Result + Settings windows** — result window shows the Typst output with a one-click copy-to-clipboard button; settings window manages the Anthropic API key and model choice, persisted locally (`config.rs`).

## Definition of Done
- [ ] Global hotkey opens a drag-to-select overlay from any application, on any monitor
- [ ] Selected region is captured, OCR'd, and converted to Typst markup within a few seconds, shown in a result window
- [ ] "Copy Typst" button places the markup on the clipboard, ready to paste into a `.typ` file
- [ ] Settings window lets the user set/update their Anthropic API key and OCR model, and the values persist across restarts
- [ ] Converter correctly handles fractions, roots, sub/superscripts, Greek letters, matrices, cases, and common operators/symbols, verified by an automated test suite
- [ ] App runs as a background tray utility (no main window) on at least one desktop OS
