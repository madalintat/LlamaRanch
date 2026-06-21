use super::{ChatBackend, Lifecycle, Message, Usage};
use std::io::{BufRead, BufReader};
use std::time::Duration;

/// Extract the assistant text delta from one SSE `data:` line.
/// Returns None for keep-alives, the `[DONE]` sentinel, or lines without content.
pub fn parse_sse_content(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let piece = v.get("choices")?.get(0)?.get("delta")?.get("content")?.as_str()?;
    if piece.is_empty() { None } else { Some(piece.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#;
        assert_eq!(parse_sse_content(line).as_deref(), Some("Hel"));
    }
    #[test]
    fn ignores_done_and_empty() {
        assert_eq!(parse_sse_content("data: [DONE]"), None);
        assert_eq!(parse_sse_content(""), None);
        assert_eq!(parse_sse_content("data: {\"choices\":[{\"delta\":{}}]}"), None);
    }
}

/// Streams from the local llama-server router on `port`.
pub struct RouterChatBackend {
    pub port: u16,
}

impl ChatBackend for RouterChatBackend {
    fn stream(
        &self,
        model_id: &str,
        messages: &[Message],
        on_token: &mut dyn FnMut(String),
    ) -> Result<Usage, String> {
        let url = format!("http://127.0.0.1:{}/v1/chat/completions", self.port);
        let body = serde_json::json!({
            "model": model_id,
            "messages": messages,
            "stream": true,
        });
        let resp = ureq::post(&url)
            .timeout(Duration::from_secs(600))
            .send_json(body)
            .map_err(|e| e.to_string())?;
        let reader = BufReader::new(resp.into_reader());
        let mut completion = 0u32;
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            if let Some(piece) = parse_sse_content(&line) {
                completion += 1;
                on_token(piece);
            }
        }
        Ok(Usage { prompt_tokens: 0, completion_tokens: completion })
    }
}

/// Loads a model via the router and waits briefly for readiness.
pub struct RouterLifecycle {
    pub port: u16,
}

impl Lifecycle for RouterLifecycle {
    fn ensure_loaded(&self, model_id: &str) -> Result<(), String> {
        // server::load is idempotent: loading an already-loaded model is a no-op.
        crate::server::load(self.port, model_id)
    }
}
