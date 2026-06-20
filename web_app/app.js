// Img2TypTeX web app - application logic.
//
// Mirrors the desktop Tauri app's flow (choice screen -> capture/upload ->
// OCR -> LaTeX-to-Typst -> copyable result) but with browser-native APIs
// standing in for Tauri commands: getDisplayMedia instead of the xcap crate,
// fetch("/api/ocr") instead of a local Rust HTTP client, localStorage instead
// of a JSON config file on disk, and navigator.clipboard instead of the
// copy_to_clipboard invoke command.

import { latexToTypst } from "./lib/converter.js";

const contentEl = document.getElementById("content");
const themeBtn = document.getElementById("theme-btn");
const settingsBtn = document.getElementById("settings-btn");

const settingsBackdrop = document.getElementById("settings-backdrop");
const apiKeyEl = document.getElementById("api-key");
const toggleKeyEl = document.getElementById("toggle-key");
const modelEl = document.getElementById("model");
const settingsToastEl = document.getElementById("settings-toast");

const fileInputEl = document.getElementById("file-input");

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // stay under the serverless function's body-size limit
const MAX_IMAGE_DIMENSION = 1800; // px - equation crops never need more resolution than this for OCR

// --- Theme -------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  if (theme === "light") {
    themeBtn.textContent = "☀"; // sun
    themeBtn.title = "Switch to dark mode";
  } else {
    themeBtn.textContent = "\u{1F319}"; // crescent moon
    themeBtn.title = "Switch to light mode";
  }
}

function initTheme() {
  applyTheme(localStorage.getItem("img2typtex-theme") || "dark");
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    localStorage.setItem("img2typtex-theme", next);
  });
}

// --- Settings: API key + model, stored client-side only ----------------

function loadSettings() {
  return {
    apiKey: localStorage.getItem("img2typtex-api-key") || "",
    model: localStorage.getItem("img2typtex-model") || "",
  };
}

function openSettings() {
  const { apiKey, model } = loadSettings();
  apiKeyEl.value = apiKey;
  apiKeyEl.type = "password";
  modelEl.value = model;
  settingsBackdrop.style.display = "flex";
  apiKeyEl.focus();
}

function closeSettings() {
  settingsBackdrop.style.display = "none";
}

function initSettings() {
  settingsBtn.addEventListener("click", openSettings);
  document.getElementById("settings-cancel-btn").addEventListener("click", closeSettings);
  settingsBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsBackdrop) closeSettings();
  });
  toggleKeyEl.addEventListener("click", () => {
    apiKeyEl.type = apiKeyEl.type === "password" ? "text" : "password";
  });
  document.getElementById("settings-save-btn").addEventListener("click", () => {
    localStorage.setItem("img2typtex-api-key", apiKeyEl.value.trim());
    localStorage.setItem("img2typtex-model", modelEl.value.trim());
    settingsToastEl.classList.add("visible");
    setTimeout(() => settingsToastEl.classList.remove("visible"), 1100);
    setTimeout(closeSettings, 350);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsBackdrop.style.display === "flex") closeSettings();
  });
}

// --- View rendering: choice / dropzone / loading / error / success ------

function clearPasteListener() {
  if (contentEl._cleanupPaste) {
    contentEl._cleanupPaste();
    contentEl._cleanupPaste = null;
  }
}

function renderChoice() {
  clearPasteListener();
  contentEl.className = "choice-screen";
  contentEl.innerHTML = "";

  const buttons = document.createElement("div");
  buttons.className = "choice-buttons";

  const snipBtn = document.createElement("button");
  snipBtn.className = "primary choice-btn";
  snipBtn.type = "button";
  snipBtn.textContent = "Snip from Screen";
  snipBtn.addEventListener("click", startScreenCapture);
  buttons.appendChild(snipBtn);

  const uploadBtn = document.createElement("button");
  uploadBtn.className = "choice-btn";
  uploadBtn.type = "button";
  uploadBtn.textContent = "Upload / Paste Image";
  uploadBtn.addEventListener("click", renderUploadZone);
  buttons.appendChild(uploadBtn);

  contentEl.appendChild(buttons);

  if (!loadSettings().apiKey) {
    const tip = document.createElement("p");
    tip.className = "empty-state";
    tip.style.fontSize = "12px";
    tip.textContent = "Tip: add your Anthropic API key in Settings (gear icon) before snipping or uploading.";
    contentEl.appendChild(tip);
  }
}

function renderUploadZone() {
  contentEl.className = "";
  contentEl.innerHTML = "";

  const zone = document.createElement("div");
  zone.className = "dropzone";
  zone.innerHTML =
    '<span class="dz-icon">&#128247;</span>' +
    "<div>Drag &amp; drop an image, click to choose a file,<br />or paste (Ctrl/Cmd+V) anywhere on this page</div>" +
    '<div class="dz-hint">PNG, JPEG, GIF, WebP, or BMP &middot; up to 8&nbsp;MB</div>';
  contentEl.appendChild(zone);

  const backRow = document.createElement("div");
  backRow.className = "row";
  backRow.style.marginTop = "14px";
  backRow.style.justifyContent = "center";
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.textContent = "← Back";
  backBtn.addEventListener("click", renderChoice);
  backRow.appendChild(backBtn);
  contentEl.appendChild(backRow);

  zone.addEventListener("click", () => fileInputEl.click());
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleImageFile(file);
  });

  // Paste listener is scoped to this view only - removed on navigation away
  // (see clearPasteListener) so it doesn't fire on an unrelated screen later.
  const pasteHandler = (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          window.removeEventListener("paste", pasteHandler);
          handleImageFile(file);
        }
        return;
      }
    }
  };
  window.addEventListener("paste", pasteHandler);
  contentEl._cleanupPaste = () => window.removeEventListener("paste", pasteHandler);
}

fileInputEl.addEventListener("change", () => {
  const file = fileInputEl.files && fileInputEl.files[0];
  fileInputEl.value = ""; // allow re-selecting the same file later
  if (file) handleImageFile(file);
});

function renderLoading() {
  clearPasteListener();
  contentEl.className = "";
  contentEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "loading-state";
  wrap.innerHTML = '<div class="spinner"></div><div>Recognising equation&hellip;</div>';
  contentEl.appendChild(wrap);
}

function renderError(message) {
  clearPasteListener();
  contentEl.className = "";
  contentEl.innerHTML = "";

  const box = document.createElement("div");
  box.className = "error-box";
  box.textContent = message;
  contentEl.appendChild(box);

  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "14px";
  const retryBtn = document.createElement("button");
  retryBtn.className = "primary";
  retryBtn.type = "button";
  retryBtn.textContent = "Start Over";
  retryBtn.addEventListener("click", renderChoice);
  row.appendChild(retryBtn);
  contentEl.appendChild(row);
}

function buildCopyCard(labelText, value, copyLabel) {
  const card = document.createElement("div");
  card.className = "card";

  const label = document.createElement("label");
  label.textContent = labelText;
  card.appendChild(label);

  const textarea = document.createElement("textarea");
  textarea.readOnly = true;
  textarea.rows = 6;
  textarea.value = value;
  card.appendChild(textarea);

  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "10px";

  const copyBtn = document.createElement("button");
  copyBtn.className = "primary";
  copyBtn.type = "button";
  copyBtn.textContent = copyLabel;
  row.appendChild(copyBtn);

  const toast = document.createElement("span");
  toast.className = "toast";
  toast.textContent = "Copied!";
  row.appendChild(toast);

  card.appendChild(row);

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.classList.add("visible");
      setTimeout(() => toast.classList.remove("visible"), 1300);
    } catch (err) {
      toast.textContent = `Copy failed: ${err.message || err}`;
      toast.classList.add("visible");
    }
  });

  return card;
}

function renderSuccess(latex) {
  let typst;
  try {
    typst = latexToTypst(latex);
  } catch (err) {
    renderError(`Recognised the LaTeX but could not convert it to Typst: ${err.message || err}`);
    return;
  }

  clearPasteListener();
  contentEl.className = "";
  contentEl.innerHTML = "";

  contentEl.appendChild(buildCopyCard("Typst markup", typst, "Copy Typst"));
  contentEl.appendChild(buildCopyCard("Recognised LaTeX", latex, "Copy LaTeX"));

  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "14px";
  const againBtn = document.createElement("button");
  againBtn.type = "button";
  againBtn.textContent = "↻ Start Over";
  againBtn.addEventListener("click", renderChoice);
  row.appendChild(againBtn);
  contentEl.appendChild(row);
}

// --- Image handling: load, downscale, base64-encode, send to /api/ocr ---

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that file as an image."));
    };
    img.src = url;
  });
}

/** Draws `source` onto a canvas, downscaling so neither dimension exceeds
 * MAX_IMAGE_DIMENSION, and returns a base64 PNG string (no data: prefix).
 * Keeping the payload small matters more here than on the desktop app,
 * since this travels over an HTTP request body instead of straight to a
 * local process. */
function toBase64Png(source, naturalWidth, naturalHeight) {
  let width = naturalWidth;
  let height = naturalHeight;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(source, 0, 0, width, height);
  return canvas.toDataURL("image/png").split(",")[1];
}

async function handleImageFile(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    renderError(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB, which is over the 8 MB limit. Try a smaller image or crop it first.`
    );
    return;
  }
  renderLoading();
  try {
    const img = await fileToImage(file);
    const base64 = toBase64Png(img, img.naturalWidth, img.naturalHeight);
    await runOcr(base64, "image/png");
  } catch (err) {
    renderError(err.message || String(err));
  }
}

async function runOcr(imageBase64, mediaType) {
  const { apiKey, model } = loadSettings();
  if (!apiKey) {
    renderError("No Anthropic API key set. Open Settings (gear icon) and add one first.");
    return;
  }
  try {
    const res = await fetch("/api/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey, model, imageBase64, mediaType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      renderError(data.error || `OCR request failed (HTTP ${res.status}).`);
      return;
    }
    renderSuccess(data.latex);
  } catch (err) {
    renderError(`Could not reach the OCR endpoint: ${err.message || err}`);
  }
}

// --- Screen capture + drag-to-crop --------------------------------------

async function startScreenCapture() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    renderError(
      "This browser doesn't support screen capture. Try Upload / Paste Image instead, or use a recent Chrome, Edge, or Firefox."
    );
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    // User cancelled the browser's share picker or denied permission - quietly
    // stay on the choice screen rather than showing a red error box for it.
    return;
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });
  await video.play().catch(() => {});
  // Let a couple of frames actually paint before grabbing one, so the
  // capture below isn't a blank/black first frame.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  frameCanvas.getContext("2d").drawImage(video, 0, 0);

  // One frame is all that's needed - stop sharing immediately so the
  // browser's "you are sharing your screen" indicator clears right away.
  stream.getTracks().forEach((t) => t.stop());

  openCropOverlay(frameCanvas);
}

function openCropOverlay(frameCanvas) {
  const overlay = document.createElement("div");
  overlay.className = "crop-overlay";
  overlay.innerHTML =
    '<div id="crop-hint">Drag to select the equation &nbsp;&middot;&nbsp; <span style="opacity:.7">Esc to cancel</span></div>' +
    '<div class="crop-stage"><div class="crop-selection"><div class="crop-dimensions"></div></div></div>' +
    '<div class="row"><button id="crop-cancel" type="button">Cancel</button></div>';
  document.body.appendChild(overlay);

  const stage = overlay.querySelector(".crop-stage");
  const selectionEl = overlay.querySelector(".crop-selection");
  const dimensionsEl = overlay.querySelector(".crop-dimensions");
  stage.insertBefore(frameCanvas, selectionEl);

  let dragStart = null;
  let stageRect = null;

  function pointInStage(e) {
    return {
      x: Math.min(Math.max(e.clientX - stageRect.left, 0), stageRect.width),
      y: Math.min(Math.max(e.clientY - stageRect.top, 0), stageRect.height),
    };
  }

  function rectFromPoints(p0, p1) {
    return {
      x: Math.min(p0.x, p1.x),
      y: Math.min(p0.y, p1.y),
      width: Math.abs(p1.x - p0.x),
      height: Math.abs(p1.y - p0.y),
    };
  }

  function paintSelection(rect) {
    selectionEl.style.display = "block";
    selectionEl.style.left = `${rect.x}px`;
    selectionEl.style.top = `${rect.y}px`;
    selectionEl.style.width = `${rect.width}px`;
    selectionEl.style.height = `${rect.height}px`;
    dimensionsEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }

  function onMouseDown(e) {
    stageRect = frameCanvas.getBoundingClientRect();
    dragStart = pointInStage(e);
    paintSelection(rectFromPoints(dragStart, dragStart));
  }

  function onMouseMove(e) {
    if (!dragStart) return;
    paintSelection(rectFromPoints(dragStart, pointInStage(e)));
  }

  function onMouseUp(e) {
    if (!dragStart) return;
    const finalRect = rectFromPoints(dragStart, pointInStage(e));
    dragStart = null;

    if (finalRect.width < 4 || finalRect.height < 4) {
      cleanup();
      return;
    }

    // Map the displayed (CSS pixel) rect back to the canvas's native pixel
    // coordinates - the canvas is shown scaled-to-fit via max-width/
    // max-height, but its bitmap is the full capture resolution.
    const scaleX = frameCanvas.width / stageRect.width;
    const scaleY = frameCanvas.height / stageRect.height;
    const sx = Math.round(finalRect.x * scaleX);
    const sy = Math.round(finalRect.y * scaleY);
    const sw = Math.round(finalRect.width * scaleX);
    const sh = Math.round(finalRect.height * scaleY);

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = sw;
    cropCanvas.height = sh;
    cropCanvas.getContext("2d").drawImage(frameCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    cleanup();
    renderLoading();
    const base64 = toBase64Png(cropCanvas, sw, sh);
    runOcr(base64, "image/png");
  }

  function onKeydown(e) {
    if (e.key === "Escape") cleanup();
  }

  function cleanup() {
    frameCanvas.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  }

  frameCanvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeydown);
  overlay.querySelector("#crop-cancel").addEventListener("click", cleanup);
}

// --- Boot ----------------------------------------------------------------

initTheme();
initSettings();
renderChoice();
