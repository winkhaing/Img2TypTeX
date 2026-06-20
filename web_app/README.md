# Img2TypTeX (web)

Browser port of the desktop Img2TypTeX app: snip your screen or upload/paste
an image of a math equation, OCR it with Claude's vision model, get
ready-to-paste Typst (and LaTeX) back. Static frontend + one Vercel
serverless function, no build step, no server-side secrets.

## How it works

- `index.html` / `style.css` / `app.js` - the page. No framework, no bundler.
- `lib/converter.js` - the LaTeX-to-Typst transpiler, copied verbatim from
  the desktop app's `src/lib/converter.js` (zero Tauri dependency, so it
  needed no changes).
- `api/ocr.js` - a Vercel serverless function that proxies one OCR request
  to Anthropic's Messages API. This exists only because Anthropic's API
  blocks plain cross-origin browser requests; the browser calls this
  same-origin endpoint instead.

## API key model: bring-your-own-key

There is **no Anthropic API key configured anywhere on the server** - not as
a Vercel environment variable, not in any file in this folder. Each user
pastes their own key into the Settings panel (gear icon); it's saved only in
that browser's `localStorage` and sent only to this app's own `/api/ocr`
endpoint, once per OCR request, in the POST body. `api/ocr.js` forwards it to
Anthropic for that single request and never logs, stores, or caches it.

This means the app can be deployed to Vercel with zero configuration - no
environment variables to set - and each user supplies their own usage/billing
via their own Anthropic key.

## Local development

```bash
npm install -g vercel   # if you don't already have the CLI
cd web_app
vercel dev
```

`vercel dev` is recommended over a plain static file server (e.g. `npx serve`)
because a static server has no way to run `api/ocr.js` - the OCR button will
fail with a 404 on `/api/ocr` unless something is actually executing the
serverless function locally.

To re-run the converter's unit tests on their own (no server needed):

```bash
npm run test:converter
```

## Deploying to Vercel

This repo's root is the Tauri desktop app, with this web app living in the
`web_app/` subfolder - so when importing the repo into Vercel, set the
project's **Root Directory** to `web_app`. No other configuration,
environment variables, or `vercel.json` is required; Vercel's zero-config
"Other" framework preset serves the static files and turns `api/ocr.js` into
the `/api/ocr` endpoint automatically.

Alternatively, run `vercel` directly from inside `web_app/` and it will pick
up the same root automatically.

## Screen capture notes

- Browsers re-prompt with their native share picker on *every* snip - unlike
  camera/mic, there's no persistent "remember this" permission for
  `getDisplayMedia()`. This is a browser platform limitation, not something
  this app can work around.
- Capture quality/behaviour (e.g. capturing a single window vs. the whole
  screen, cursor visibility) varies by browser and OS. Chrome and Edge tend
  to offer the most complete picker (screen / window / tab); Firefox and
  Safari are more limited.
- Requires a secure context (HTTPS or `localhost`) - satisfied automatically
  by both Vercel deployments and `vercel dev`.
- If screen capture isn't available or permitted, "Upload / Paste Image"
  covers the same use case via a screenshot taken with the OS's own
  screenshot tool, then pasted or dragged in.
