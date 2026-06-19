// Calls the Anthropic Messages API (vision) to OCR a math equation image
// into raw LaTeX source. The LaTeX -> Typst conversion itself happens on the
// frontend (src/lib/converter.js), which is already unit-tested there; this
// module's only job is "image in, LaTeX text out".

use serde::{Deserialize, Serialize};
use std::time::Duration;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

const SYSTEM_PROMPT: &str = "You are an OCR engine specialised in mathematical notation. \
Transcribe the mathematical expression(s) in the image into LaTeX source. \
Output ONLY the raw LaTeX - no markdown code fences, no $ or $$ delimiters, no \\[ \\], \
no explanation, and no surrounding prose. \
Preserve structure exactly: use align*/aligned, cases, pmatrix/bmatrix/vmatrix, etc. \
where the image shows multi-line or matrix layouts. If the image contains no \
recognisable math, output exactly: NO_EQUATION_FOUND";

#[derive(Serialize)]
struct ImageSource<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    media_type: &'a str,
    data: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ContentBlock<'a> {
    Image { source: ImageSource<'a> },
    Text { text: String },
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: Vec<ContentBlock<'a>>,
}

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<Message<'a>>,
}

#[derive(Deserialize)]
struct ResponseTextBlock {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct MessagesResponse {
    #[serde(default)]
    content: Vec<ResponseTextBlock>,
    #[serde(default)]
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

/// Sends a base64-encoded PNG to Claude and returns the raw LaTeX it
/// transcribed. Returns `Err` with a user-displayable message on any
/// network, auth, or parsing failure.
pub async fn recognize_latex(
    api_key: &str,
    model: &str,
    png_base64: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))?;

    let body = MessagesRequest {
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: vec![Message {
            role: "user",
            content: vec![
                ContentBlock::Image {
                    source: ImageSource {
                        kind: "base64",
                        media_type: "image/png",
                        data: png_base64,
                    },
                },
                ContentBlock::Text {
                    text: "Transcribe the equation in this image to LaTeX.".to_string(),
                },
            ],
        }],
    };

    let response = client
        .post(ANTHROPIC_API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("could not reach Anthropic API: {e}"))?;

    let status = response.status();
    let parsed: MessagesResponse = response
        .json()
        .await
        .map_err(|e| format!("could not parse Anthropic API response: {e}"))?;

    if let Some(err) = parsed.error {
        return Err(format!("Anthropic API error: {}", err.message));
    }
    if !status.is_success() {
        return Err(format!("Anthropic API returned HTTP {status}"));
    }

    let raw = parsed
        .content
        .into_iter()
        .find(|b| b.kind == "text")
        .and_then(|b| b.text)
        .ok_or_else(|| "Anthropic API response had no text content".to_string())?;

    let cleaned = strip_code_fence(raw.trim());

    if cleaned == "NO_EQUATION_FOUND" || cleaned.is_empty() {
        return Err("No equation was found in the selected region.".to_string());
    }

    Ok(cleaned.to_string())
}

/// Defensively strips a ```latex ... ``` / ``` ... ``` wrapper in case the
/// model adds one despite being told not to.
fn strip_code_fence(s: &str) -> &str {
    let s = s.trim();
    if let Some(stripped) = s.strip_prefix("```") {
        let stripped = stripped.trim_start_matches("latex").trim_start_matches("tex");
        let stripped = stripped.trim_start_matches('\n');
        if let Some(end) = stripped.rfind("```") {
            return stripped[..end].trim();
        }
        return stripped.trim();
    }
    s
}
