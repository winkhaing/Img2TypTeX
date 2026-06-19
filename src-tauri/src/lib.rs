// Wires together the tray icon, global shortcut, snip overlay, result
// window, and settings window. The actual OCR call lives in `ocr.rs`, the
// screen-capture logic lives in `capture.rs`, and API-key/model persistence
// lives in `config.rs` — this module just orchestrates them behind a set of
// Tauri commands the frontend can invoke.

mod capture;
mod config;
mod ocr;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{WebviewWindow, WebviewWindowBuilder},
    AppHandle, Emitter, Manager, WebviewUrl,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use capture::{capture_region_as_png_base64, encode_image_file_as_png_base64, PhysicalRect};

const OVERLAY_LABEL: &str = "overlay";
const RESULT_LABEL: &str = "result";
const SETTINGS_LABEL: &str = "settings";
const SNIP_SHORTCUT: &str = "Alt+Shift+M";

/// Outcome of a single snip-and-recognize attempt, sent back to the
/// frontend (and cached for the result window to re-fetch on open).
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum OcrOutcome {
    Success { latex: String },
    Error { message: String },
}

/// A drag-selection rectangle in the overlay window's own logical pixels,
/// as reported by the frontend. Converted to monitor-local physical pixels
/// before being handed to `capture::capture_region_as_png_base64`.
#[derive(Deserialize)]
pub struct SelectionRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
pub struct AppState {
    last_result: Mutex<Option<OcrOutcome>>,
}

/// Opens the full-screen snip overlay on the monitor under the cursor (or
/// the primary monitor as a fallback), or just focuses it if already open.
fn trigger_snip(app: &AppHandle) {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = existing.set_focus();
        return;
    }

    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|pos| app.monitor_from_point(pos.x, pos.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        eprintln!("Img2TypTeX: could not determine a monitor to snip on");
        return;
    };

    let phys_pos = monitor.position();
    let phys_size = monitor.size();

    // Deliberately not setting position/size on the builder via `.position()`
    // / `.inner_size()` here: those take *logical* units, and converting this
    // monitor's physical position/size to logical pixels requires dividing by
    // *a* scale factor before the window exists on any monitor — when the
    // target monitor's scale factor differs from the primary monitor's (e.g.
    // a Retina built-in display plus a non-Retina external one), that
    // conversion is ambiguous and can place the window on the wrong monitor
    // entirely. Setting physical position/size directly below sidesteps that
    // ambiguity, and keeps `capture_and_recognize`'s monitor lookup (which
    // probes `window.outer_position()`) pointed at the right screen.
    let builder = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("overlay.html".into()))
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(true)
        .title("Img2TypTeX Snip");

    match builder.build() {
        Ok(window) => {
            let _ = window.set_position(tauri::Position::Physical(*phys_pos));
            let _ = window.set_size(tauri::Size::Physical(*phys_size));
            let _ = window.set_focus();
        }
        Err(e) => eprintln!("Img2TypTeX: failed to open overlay window: {e}"),
    }
}

/// Opens a native "choose an image file" dialog and runs the same OCR
/// pipeline a live screen snip uses, sourcing the image from disk instead of
/// `capture::capture_region_as_png_base64`. This is the file-upload entry
/// point, reachable from the tray menu ("Open Image File…") alongside Snip
/// Equation — chosen over a dedicated global shortcut or a Settings-window
/// button as the most discoverable option given the app has no persistent
/// main window. `pick_file` is non-blocking and safe to call from the main
/// thread; if the user cancels the dialog, nothing happens.
fn trigger_open_file(app: &AppHandle) {
    let app_handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
        .pick_file(move |picked| {
            let Some(picked) = picked else { return };
            let Ok(path) = picked.into_path() else {
                return;
            };

            tauri::async_runtime::spawn(async move {
                let outcome = run_ocr_on_file(path, &app_handle).await;

                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut last) = state.last_result.lock() {
                        *last = Some(outcome);
                    }
                }

                show_result_window(&app_handle);
            });
        });
}

/// Shows the result window (creating it on first use) and notifies it that
/// `get_last_result` now has fresh data.
fn show_result_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(RESULT_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("ocr-result-updated", ());
        return;
    }

    let builder = WebviewWindowBuilder::new(app, RESULT_LABEL, WebviewUrl::App("result.html".into()))
        .title("Img2TypTeX Result")
        // Tall enough that a successful result - the "Typst markup" card AND
        // the "Recognised LaTeX" card, each with its own 6-row textarea plus
        // a "Copy ..." button - fits in full without the window needing to
        // be resized or the content scrolled. Was 480x360, which clipped the
        // second card's copy button below the fold.
        .inner_size(520.0, 620.0)
        .min_inner_size(420.0, 480.0)
        .resizable(true)
        .center()
        .focused(true);

    match builder.build() {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(e) => eprintln!("Img2TypTeX: failed to open result window: {e}"),
    }
}

/// Shows the settings window (creating it on first use).
fn open_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let builder = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("settings.html".into()))
        .title("Img2TypTeX Settings")
        .inner_size(420.0, 320.0)
        .resizable(false)
        .center()
        .focused(true);

    match builder.build() {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(e) => eprintln!("Img2TypTeX: failed to open settings window: {e}"),
    }
}

/// Captures the selected region and runs OCR on it. Always returns an
/// `OcrOutcome` — errors are values, not early returns, so the caller never
/// has to guess whether a result was produced.
async fn run_capture_and_ocr(
    probe_point: (i32, i32),
    physical_rect: PhysicalRect,
    app: &AppHandle,
) -> OcrOutcome {
    let png_base64 = match capture_region_as_png_base64(probe_point, physical_rect) {
        Ok(b64) => b64,
        Err(message) => return OcrOutcome::Error { message },
    };

    run_ocr_on_png_base64(png_base64, app).await
}

/// Reads an uploaded image file from disk and runs it through the same OCR
/// pipeline a live screen snip uses. The decode/re-encode step is a blocking
/// filesystem + image-codec operation, so it runs via `spawn_blocking`
/// rather than directly on the async runtime.
async fn run_ocr_on_file(path: std::path::PathBuf, app: &AppHandle) -> OcrOutcome {
    let png_base64 = match tokio::task::spawn_blocking(move || encode_image_file_as_png_base64(&path)).await
    {
        Ok(Ok(b64)) => b64,
        Ok(Err(message)) => return OcrOutcome::Error { message },
        Err(e) => {
            return OcrOutcome::Error {
                message: format!("internal error reading the selected file: {e}"),
            }
        }
    };

    run_ocr_on_png_base64(png_base64, app).await
}

/// Shared tail of both OCR entry points (live snip and file upload): looks
/// up the configured API key/model and calls the Anthropic vision API.
async fn run_ocr_on_png_base64(png_base64: String, app: &AppHandle) -> OcrOutcome {
    let api_key = match config::load_api_key(app) {
        Some(key) if !key.trim().is_empty() => key,
        _ => {
            return OcrOutcome::Error {
                message: "No Anthropic API key set. Open Settings to add one.".to_string(),
            };
        }
    };

    let model = config::load_model(app);

    match ocr::recognize_latex(&api_key, &model, png_base64).await {
        Ok(latex) => OcrOutcome::Success { latex },
        Err(message) => OcrOutcome::Error { message },
    }
}

/// Hands the overlay-local selection off to `capture::capture_region_as_png_base64`,
/// runs OCR, caches the outcome, closes the overlay, and shows the result window.
///
/// Two coordinate systems are in play here, and they must not be mixed:
/// `xcap` (the screen-capture crate) validates and captures regions in the
/// same unit its own `Monitor::width()/height()` report — on macOS that's
/// *points* (from `CGDisplayBounds`), not raw backing pixels. The overlay's
/// `rect` comes straight from CSS mouse coordinates inside the webview,
/// which are already points on macOS (1 CSS px = 1 point, regardless of
/// Retina backing scale) — so it's passed through to `capture` unscaled.
/// `window.outer_position()`, on the other hand, comes from Tauri/tao and
/// *is* in physical pixels, so it has to be divided by the window's own
/// scale factor before it's used to probe `xcap::Monitor::from_point`,
/// which also expects points. Multiplying (or leaving unconverted) the
/// wrong one of these is what previously caused both "capture region
/// outside monitor bounds" and "wrong monitor" failures on Retina /
/// mixed-DPI multi-monitor setups.
#[tauri::command]
async fn capture_and_recognize(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    rect: SelectionRect,
) -> Result<OcrOutcome, ()> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let outer = window.outer_position().unwrap_or_default();

    let monitor_rect = PhysicalRect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    };
    let probe_point = (
        (outer.x as f64 / scale).round() as i32,
        (outer.y as f64 / scale).round() as i32,
    );

    let outcome = run_capture_and_ocr(probe_point, monitor_rect, &app).await;

    if let Ok(mut last) = state.last_result.lock() {
        *last = Some(outcome.clone());
    }

    let _ = window.close();
    show_result_window(&app);

    Ok(outcome)
}

#[tauri::command]
fn get_last_result(state: tauri::State<'_, AppState>) -> Option<OcrOutcome> {
    state.last_result.lock().ok().and_then(|guard| guard.clone())
}

/// Frontend-invokable wrapper around `trigger_snip`, so the result window's
/// own "Take Screenshot" button can start a snip directly, the same way the
/// tray menu's "Snip Equation" entry and the global shortcut already do.
#[tauri::command]
fn start_snip(app: AppHandle) {
    trigger_snip(&app);
}

/// Frontend-invokable wrapper around `trigger_open_file`, so the result
/// window's own "Upload Image File" button can open the native file picker
/// directly, the same way the tray menu's "Open Image File…" entry already
/// does.
#[tauri::command]
fn start_upload(app: AppHandle) {
    trigger_open_file(&app);
}

/// Clears the cached OCR outcome and tells the result window to re-fetch it
/// (which will come back `None`, taking it back to the Screenshot/Upload
/// choice screen). Used by the result window's "Reset" button so the user
/// can start over without closing and reopening the window.
#[tauri::command]
fn reset_result(app: AppHandle, state: tauri::State<'_, AppState>) {
    if let Ok(mut last) = state.last_result.lock() {
        *last = None;
    }
    if let Some(window) = app.get_webview_window(RESULT_LABEL) {
        let _ = window.emit("ocr-result-updated", ());
    }
}

#[tauri::command]
fn get_api_key(app: AppHandle) -> Option<String> {
    config::load_api_key(&app)
}

#[tauri::command]
fn set_api_key(app: AppHandle, key: String) -> Result<(), String> {
    config::save_api_key(&app, &key)
}

#[tauri::command]
fn get_model(app: AppHandle) -> String {
    config::load_model(&app)
}

#[tauri::command]
fn set_model(app: AppHandle, model: String) -> Result<(), String> {
    config::save_model(&app, &model)
}

#[tauri::command]
fn get_theme(app: AppHandle) -> String {
    config::load_theme(&app)
}

/// Persists the chosen theme and broadcasts it to every open window, so
/// toggling light/dark in the result window's header (or the settings
/// window's) updates the other immediately instead of only taking effect
/// the next time that window happens to reload.
#[tauri::command]
fn set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    config::save_theme(&app, &theme)?;
    let _ = app.emit("theme-changed", config::load_theme(&app));
    Ok(())
}

#[tauri::command]
fn close_current_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_to_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    open_settings(&app);
}

/// Quits the whole app (every window, the tray icon, the global shortcut
/// listener - everything), not just the window the button lives in. Same
/// effect as the tray menu's existing "Quit" entry, just reachable from the
/// result window's own header for anyone who doesn't think to look in the
/// tray.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        trigger_snip(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            capture_and_recognize,
            get_last_result,
            get_api_key,
            set_api_key,
            get_model,
            set_model,
            get_theme,
            set_theme,
            close_current_window,
            copy_to_clipboard,
            open_settings_window,
            start_snip,
            start_upload,
            reset_result,
            quit_app,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let shortcut: tauri_plugin_global_shortcut::Shortcut = SNIP_SHORTCUT
                .parse()
                .expect("SNIP_SHORTCUT is a valid shortcut string");
            handle.global_shortcut().register(shortcut)?;

            let menu = MenuBuilder::new(&handle)
                .text("snip", "Snip Equation")
                .text("upload", "Open Image File…")
                .text("settings", "Settings")
                .separator()
                .text("quit", "Quit")
                .build()?;

            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("Img2TypTeX")
                .menu(&menu)
                .show_menu_on_left_click(false);

            if let Some(icon) = handle.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            let tray_handle = handle.clone();
            tray_builder
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "snip" => trigger_snip(app),
                    "upload" => trigger_open_file(app),
                    "settings" => open_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        trigger_snip(&tray_handle);
                    }
                })
                .build(&handle)?;

            // Show the result window immediately on launch, in its
            // default/no-result state (the Screenshot/Upload choice
            // screen) - previously this was a pure tray app with no visible
            // window until the first snip or upload finished, leaving
            // "how do I start" undiscoverable.
            show_result_window(&handle);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Img2TypTeX");
}
