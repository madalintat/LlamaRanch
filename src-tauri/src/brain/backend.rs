use super::{ChatBackend, Message, StepResult, ToolCall, Usage};
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

/// Assemble complete tool calls from streamed `delta.tool_calls` fragments.
/// Each fragment: {index, id?, function:{name?, arguments?}}. `arguments` may
/// arrive as a string (fragments concatenated) or as an object (normalize to string).
pub fn aggregate_tool_calls(fragments: &[serde_json::Value]) -> Vec<ToolCall> {
    use std::collections::BTreeMap;
    let mut acc: BTreeMap<i64, (String, String, String)> = BTreeMap::new(); // index -> (id,name,args)
    for f in fragments {
        let idx = f.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
        let e = acc.entry(idx).or_default();
        if let Some(id) = f.get("id").and_then(|v| v.as_str()) {
            if !id.is_empty() { e.0 = id.to_string(); }
        }
        if let Some(func) = f.get("function") {
            if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() { e.1 = name.to_string(); }
            }
            if let Some(a) = func.get("arguments") {
                if let Some(s) = a.as_str() {
                    e.2.push_str(s);
                } else if !a.is_null() {
                    // object form (llama.cpp quirk) → serialize once
                    e.2 = a.to_string();
                }
            }
        }
    }
    acc.into_values()
        .filter(|(_, name, _)| !name.is_empty())
        .map(|(id, name, args)| ToolCall {
            id,
            name,
            arguments: if args.is_empty() { "{}".into() } else { args },
        })
        .collect()
}

#[cfg(test)]
mod agg_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aggregates_string_fragments() {
        let frags = vec![
            json!({"index":0,"id":"c1","function":{"name":"calculate","arguments":"{\"expr"}}),
            json!({"index":0,"function":{"arguments":"ession\":\"2+2\"}"}}),
        ];
        let got = aggregate_tool_calls(&frags);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "calculate");
        assert_eq!(got[0].arguments, "{\"expression\":\"2+2\"}");
    }
    #[test]
    fn normalizes_object_arguments() {
        let frags = vec![json!({"index":0,"id":"c","function":{"name":"get_time","arguments":{}}})];
        let got = aggregate_tool_calls(&frags);
        assert_eq!(got[0].arguments, "{}");
    }
    #[test]
    fn no_fragments_is_empty() {
        assert!(aggregate_tool_calls(&[]).is_empty());
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

    fn step(
        &self,
        model_id: &str,
        messages: &[serde_json::Value],
        tools: &serde_json::Value,
        on_token: &mut dyn FnMut(String),
    ) -> Result<StepResult, String> {
        let url = format!("http://127.0.0.1:{}/v1/chat/completions", self.port);
        let body = serde_json::json!({
            "model": model_id, "messages": messages, "tools": tools, "stream": true
        });
        let resp = ureq::post(&url).timeout(Duration::from_secs(600))
            .send_json(body).map_err(|e| e.to_string())?;
        let reader = BufReader::new(resp.into_reader());
        let mut content = String::new();
        let mut frags: Vec<serde_json::Value> = Vec::new();
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let data = match line.strip_prefix("data:") { Some(d) => d.trim(), None => continue };
            if data.is_empty() || data == "[DONE]" { continue; }
            let v: serde_json::Value = match serde_json::from_str(data) { Ok(v) => v, Err(_) => continue };
            let delta = match v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("delta")) {
                Some(d) => d, None => continue,
            };
            if let Some(piece) = delta.get("content").and_then(|c| c.as_str()) {
                if !piece.is_empty() { content.push_str(piece); on_token(piece.to_string()); }
            }
            if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                frags.extend(tcs.iter().cloned());
            }
        }
        Ok(StepResult { content, tool_calls: aggregate_tool_calls(&frags) })
    }
}
