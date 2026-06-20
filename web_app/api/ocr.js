// Vercel serverless function: proxies a single vision-OCR request to
// Anthropic's Messages API.
//
// Why this exists at all (rather than calling Anthropic directly from the
// browser): Anthropic's API does not allow plain cross-origin browser
// requests, and even if it did, putting the user's API key directly in a
// browser-originated request is the kind of thing that ages badly. So the
// browser calls this same-origin endpoint instead, which forwards the
// request server-side.
//
// API-key model: bring-your-own-key, same as the desktop app. The key is
// supplied by the client on every request body and is never stored,
// logged, or cached here - it only ever exists in memory for the duration
// of this one request. There is no Anthropic key configured as a Vercel
// environment variable, and none is required to deploy this project.
//
// Mirrors the prompt/parsing logic of the desktop app's
// src-tauri/src/ocr.rs 1:1 so OCR behaviour is identical between the two.

export const config = {
  api: {
    bodyParser: {
      // Base64-encoded PNGs inflate ~37% over raw bytes; this leaves enough
      // room for a reasonably large snip/upload while staying under
      // Vercel's platform-level request body ceiling.
      sizeLimit: "8mb",
    },
  },
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const REQUEST_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = `You are an OCR engine specialised in mathematical notation. \
Transcribe the mathematical expression(s) in the image into LaTeX source. \
Output ONLY the raw LaTeX - no markdown code fences, no $ or $$ delimiters, no \\[ \\], \
no explanation, and no surrounding prose. \
Preserve structure exactly: use align*/aligned, cases, pmatrix/bmatrix/vmatrix, etc. \
where the image shows multi-line or matrix layouts. If the image contains no \
recognisable math, output exactly: NO_EQUATION_FOUND`;

/** Defensively strips a ```latex ... ``` / ``` ... ``` wrapper in case the
 * model adds one despite being told not to. Same behaviour as the desktop
 * app's strip_code_fence in src-tauri/src/ocr.rs. */
function stripCodeFence(raw) {
  const s = raw.trim();
  if (!s.startsWith("```")) return s;
  let stripped = s.slice(3);
  stripped = stripped.replace(/^(latex|tex)/, "");
  stripped = stripped.replace(/^\n/, "");
  const end = stripped.lastIndexOf("```");
  return (end !== -1 ? stripped.slice(0, end) : stripped).trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { apiKey, model, imageBase64, mediaType } = req.body || {};

  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return res.status(400).json({
      error: "Missing Anthropic API key. Add one in Settings before snipping or uploading.",
    });
  }
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "Missing image data." });
  }

  const usedModel = (model && String(model).trim()) || DEFAULT_MODEL;
  const usedMediaType = mediaType && String(mediaType).startsWith("image/") ? mediaType : "image/png";

  const anthropicBody = {
    model: usedModel,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: usedMediaType,
              data: imageBase64,
            },
          },
          { type: "text", text: "Transcribe the equation in this image to LaTeX." },
        ],
      },
    ],
  };

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey.trim(),
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(anthropicBody),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not reach Anthropic API: ${err.message || err}` });
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    return res.status(502).json({ error: "Could not parse Anthropic API response." });
  }

  if (parsed && parsed.error) {
    const status = response.status >= 400 ? response.status : 502;
    return res.status(status).json({ error: `Anthropic API error: ${parsed.error.message || JSON.stringify(parsed.error)}` });
  }
  if (!response.ok) {
    return res.status(response.status).json({ error: `Anthropic API returned HTTP ${response.status}` });
  }

  const textBlock = Array.isArray(parsed.content) ? parsed.content.find((b) => b.type === "text") : null;
  const raw = textBlock && textBlock.text;
  if (!raw) {
    return res.status(502).json({ error: "Anthropic API response had no text content." });
  }

  const cleaned = stripCodeFence(raw.trim());
  if (cleaned === "NO_EQUATION_FOUND" || cleaned.length === 0) {
    return res.status(422).json({ error: "No equation was found in the selected region." });
  }

  return res.status(200).json({ latex: cleaned });
}
