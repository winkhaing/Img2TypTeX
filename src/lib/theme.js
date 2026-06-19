// Shared light/dark theme handling for every window that loads style.css
// (result.html, settings.html). The theme itself is persisted on the Rust
// side via the get_theme/set_theme commands (see src-tauri/src/config.rs),
// not in localStorage - that way every window agrees on the active theme
// from its very first paint, and toggling in one window updates the other
// immediately via the "theme-changed" event rather than only on next reload.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** Sets the `data-theme` attribute Tauri's style.css keys its light-mode
 * variable overrides off of. */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function updateToggleButton(btn, theme) {
  if (!btn) return;
  // The icon shown is the CURRENT mode (so the button doubles as a status
  // indicator), while the tooltip describes the action a click performs.
  if (theme === "light") {
    btn.textContent = "☀"; // ☀
    btn.title = "Switch to dark mode";
  } else {
    btn.textContent = "\u{1F319}"; // 🌙
    btn.title = "Switch to light mode";
  }
}

/**
 * Loads the persisted theme, applies it, wires the given toggle button (if
 * any) to flip and persist it, and keeps this window in sync with theme
 * changes made from any other window. Safe to call once per page.
 */
export async function initTheme(toggleBtn) {
  let theme = "dark";
  try {
    theme = await invoke("get_theme");
  } catch (err) {
    // No backend reachable yet (shouldn't normally happen) - fall back to
    // the dark theme this app shipped with rather than leaving the page
    // unstyled.
  }

  applyTheme(theme);
  updateToggleButton(toggleBtn, theme);

  listen("theme-changed", (event) => {
    applyTheme(event.payload);
    updateToggleButton(toggleBtn, event.payload);
  });

  if (toggleBtn) {
    toggleBtn.addEventListener("click", async () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      applyTheme(next);
      updateToggleButton(toggleBtn, next);
      try {
        await invoke("set_theme", { theme: next });
      } catch (err) {
        // The click already applied the theme optimistically; a failed
        // save just means it won't survive a relaunch, which isn't worth
        // surfacing an error toast over.
      }
    });
  }
}
