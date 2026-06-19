// Small JSON-file-backed config store for the user's Anthropic API key.
//
// We deliberately avoid pulling in a dedicated plugin (e.g. tauri-plugin-store)
// for this single value - a tiny hand-rolled JSON file in the app's config
// directory keeps the dependency list small and is trivial to reason about.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(default)]
    anthropic_api_key: Option<String>,
    /// Anthropic model id used for OCR vision requests. Lets advanced users
    /// override the default without recompiling (see settings window).
    #[serde(default)]
    model: Option<String>,
    /// UI color theme: "dark" or "light". Stored here (rather than only in
    /// localStorage) so every window - result, settings, and any future one -
    /// agrees on the active theme from its very first paint, with no
    /// same-origin assumptions about the webview's storage.
    #[serde(default)]
    theme: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config directory: {e}"))?;
    Ok(dir.join("config.json"))
}

fn read(app: &AppHandle) -> ConfigFile {
    let Ok(path) = config_path(app) else {
        return ConfigFile::default();
    };
    let Ok(bytes) = fs::read(&path) else {
        return ConfigFile::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write(app: &AppHandle, cfg: &ConfigFile) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("could not write config file: {e}"))
}

pub fn load_api_key(app: &AppHandle) -> Option<String> {
    read(app).anthropic_api_key.filter(|k| !k.trim().is_empty())
}

pub fn save_api_key(app: &AppHandle, key: &str) -> Result<(), String> {
    let mut cfg = read(app);
    cfg.anthropic_api_key = Some(key.trim().to_string());
    write(app, &cfg)
}

pub fn load_model(app: &AppHandle) -> String {
    read(app)
        .model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "claude-sonnet-4-6".to_string())
}

pub fn save_model(app: &AppHandle, model: &str) -> Result<(), String> {
    let mut cfg = read(app);
    cfg.model = Some(model.trim().to_string());
    write(app, &cfg)
}

pub fn load_theme(app: &AppHandle) -> String {
    match read(app).theme {
        Some(t) if t == "light" => "light".to_string(),
        _ => "dark".to_string(),
    }
}

pub fn save_theme(app: &AppHandle, theme: &str) -> Result<(), String> {
    let mut cfg = read(app);
    cfg.theme = Some(if theme == "light" { "light" } else { "dark" }.to_string());
    write(app, &cfg)
}
