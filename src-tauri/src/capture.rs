// Screen region capture via the `xcap` crate.
//
// The overlay window is sized and positioned (in lib.rs) to exactly cover a
// single monitor, so the rectangle the user drags inside it is already
// expressed in that monitor's own local coordinate space. Crucially, `xcap`
// validates and captures regions in whatever unit its own
// `Monitor::width()/height()` use — on macOS that's *points* (sourced from
// `CGDisplayBounds`), not physical backing pixels, and CSS pixels from the
// overlay's webview are already points on macOS (1 CSS px = 1 point,
// regardless of Retina scale), so no scale-factor conversion is applied to
// the rect before it gets here. `xcap::Monitor::capture_region` expects
// coordinates local to that same monitor (see the crate's own examples), so
// no extra translation by the monitor's desktop-space offset is needed
// either — see `lib.rs::capture_and_recognize` for where the probe point
// (which *is* in physical pixels, from Tauri) gets converted back to points
// before being used to find the right monitor.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::Cursor;
use xcap::Monitor;

/// A rectangle local to a single monitor, in whatever unit that platform's
/// `xcap::Monitor` reports for width/height (points on macOS).
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Finds the xcap monitor that contains the given absolute desktop point
/// (physical pixels), captures `rect` (local to that monitor), encodes the
/// result as PNG, and returns it base64-encoded, ready to embed in an
/// Anthropic Messages API image content block.
///
/// This does a blocking screen-capture syscall, so callers should run it via
/// `tokio::task::spawn_blocking`.
pub fn capture_region_as_png_base64(
    probe_point: (i32, i32),
    rect: PhysicalRect,
) -> Result<String, String> {
    if rect.width == 0 || rect.height == 0 {
        return Err("selection is empty".to_string());
    }

    let monitor = Monitor::from_point(probe_point.0, probe_point.1)
        .map_err(|e| format!("could not find monitor under selection: {e}"))?;

    let image = monitor
        .capture_region(rect.x.max(0) as u32, rect.y.max(0) as u32, rect.width, rect.height)
        .map_err(|e| format!("screen capture failed: {e}"))?;

    let mut png_bytes: Vec<u8> = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("could not encode capture as PNG: {e}"))?;

    Ok(STANDARD.encode(png_bytes))
}

/// Reads an arbitrary image file from disk, decodes it, and re-encodes it as
/// a base64 PNG — the same shape `capture_region_as_png_base64` produces —
/// so the file-upload OCR path can feed `ocr::recognize_latex` identically
/// to a live screen snip, regardless of the uploaded file's original format
/// (JPEG, GIF, WebP, BMP, ...).
pub fn encode_image_file_as_png_base64(path: &std::path::Path) -> Result<String, String> {
    let image = image::open(path).map_err(|e| format!("could not read image file: {e}"))?;

    let mut png_bytes: Vec<u8> = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("could not encode image as PNG: {e}"))?;

    Ok(STANDARD.encode(png_bytes))
}
