//! Tool-calling reliability eval: measure whether a model can be trusted to
//! produce valid tool calls before you put it on agent work. A model can ace
//! tools in one harness and fail completely in another, so we run a small fixed
//! eval against the model through the router (same `--jinja` parsing the agent
//! uses) and report a score and a verdict. Grading and parsing are pure; only
//! the per-case request touches the network.
use crate::brain::ToolCall;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

/// One eval case: a prompt and what a reliable model should do with it. A
/// `None` expected tool means the model should answer directly and call nothing.
pub struct EvalCase {
    pub id: &'static str,
    pub prompt: &'static str,
    pub expected_tool: Option<&'static str>,
    pub must_contain: &'static [&'static str],
}

/// The curated cases. Two delegate-the-math calls, one clock call, and one that
/// should NOT call a tool (over-eager tool use is its own reliability failure).
pub fn cases() -> &'static [EvalCase] {
    &[
        EvalCase {
            id: "calc_multiply",
            prompt: "Use the calculator tool to compute 47 times 19. Do not compute it yourself.",
            expected_tool: Some("calculate"),
            must_contain: &["47", "19"],
        },
        EvalCase {
            id: "calc_add",
            prompt: "Use the calculator tool to add 128 and 256.",
            expected_tool: Some("calculate"),
            must_contain: &["128", "256"],
        },
        EvalCase {
            id: "clock",
            prompt: "Use a tool to get the current Unix timestamp.",
            expected_tool: Some("get_time"),
            must_contain: &[],
        },
        EvalCase {
            id: "no_tool",
            prompt: "Reply with a one word greeting. Do not use any tool.",
            expected_tool: None,
            must_contain: &[],
        },
    ]
}

/// The outcome of one case, ready to serialize to the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaseResult {
    pub id: String,
    pub passed: bool,
    pub detail: String,
}

/// A model's overall reliability report.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReliabilityReport {
    pub model: String,
    pub passed: u32,
    pub total: u32,
    pub score: f32, // 0.0..=1.0
    pub verdict: String,
    pub cases: Vec<CaseResult>,
}

/// Parse the `tool_calls` of a non-streamed `choices[0].message` into our shape.
pub fn parse_message_tool_calls(message: &Value) -> Vec<ToolCall> {
    let Some(arr) = message.get("tool_calls").and_then(|t| t.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let f = c.get("function")?;
            let name = f.get("name")?.as_str()?.to_string();
            let arguments = match f.get("arguments") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(), // some models return an object
                None => String::new(),
            };
            let id = c
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{i}"));
            Some(ToolCall { id, name, arguments })
        })
        .collect()
}

/// Grade one case against the tool calls a model produced.
pub fn grade(case: &EvalCase, calls: &[ToolCall]) -> CaseResult {
    let id = case.id.to_string();
    match case.expected_tool {
        None => {
            if calls.is_empty() {
                CaseResult { id, passed: true, detail: "answered without a tool, as expected".into() }
            } else {
                CaseResult {
                    id,
                    passed: false,
                    detail: format!("called {} when no tool was needed", calls[0].name),
                }
            }
        }
        Some(want) => {
            let Some(tc) = calls.iter().find(|c| c.name == want) else {
                let got = match calls.first() {
                    Some(c) => format!("called {}", c.name),
                    None => "no tool call".to_string(),
                };
                return CaseResult { id, passed: false, detail: format!("expected {want}, {got}") };
            };
            if serde_json::from_str::<Value>(&tc.arguments).is_err() {
                return CaseResult { id, passed: false, detail: "arguments were not valid JSON".into() };
            }
            for needle in case.must_contain {
                if !tc.arguments.contains(needle) {
                    return CaseResult { id, passed: false, detail: format!("arguments missing {needle:?}") };
                }
            }
            CaseResult { id, passed: true, detail: "valid tool call".into() }
        }
    }
}

/// Map a 0..1 score to a plain verdict.
pub fn verdict_for(score: f32) -> &'static str {
    if score >= 0.75 {
        "dependable"
    } else if score >= 0.5 {
        "flaky"
    } else {
        "unreliable"
    }
}

/// Aggregate case results into a report.
pub fn build_report(model: &str, results: Vec<CaseResult>) -> ReliabilityReport {
    let total = results.len() as u32;
    let passed = results.iter().filter(|r| r.passed).count() as u32;
    let score = if total == 0 { 0.0 } else { passed as f32 / total as f32 };
    ReliabilityReport {
        model: model.to_string(),
        passed,
        total,
        score,
        verdict: verdict_for(score).to_string(),
        cases: results,
    }
}

/// Send one case to the router (non-streamed, deterministic) and return the tool
/// calls it produced. A failed request yields no calls (so tool cases fail).
fn run_case(port: u16, model: &str, tools: &Value, prompt: &str) -> Vec<ToolCall> {
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "tools": tools,
        "stream": false,
        "temperature": 0.0
    });
    match ureq::post(&url).timeout(Duration::from_secs(120)).send_json(body) {
        Ok(resp) => {
            let v: Value = resp.into_json().unwrap_or(Value::Null);
            v.get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .map(parse_message_tool_calls)
                .unwrap_or_default()
        }
        Err(_) => Vec::new(),
    }
}

/// Run the full eval for a model and return its reliability report. Uses the
/// deterministic clock+calculator tool set so the score is reproducible.
pub fn run_eval(port: u16, model: &str) -> ReliabilityReport {
    let tools = crate::brain::tools::ToolRegistry::local_only().openai_tools();
    let results = cases().iter().map(|c| grade(c, &run_case(port, model, &tools, c.prompt))).collect();
    build_report(model, results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, args: &str) -> ToolCall {
        ToolCall { id: "1".into(), name: name.into(), arguments: args.into() }
    }

    #[test]
    fn parse_string_and_object_arguments() {
        let msg = json!({ "tool_calls": [
            { "id": "a", "function": { "name": "calculate", "arguments": "{\"expression\":\"47*19\"}" } },
            { "function": { "name": "get_time", "arguments": { "tz": "UTC" } } }
        ]});
        let calls = parse_message_tool_calls(&msg);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "calculate");
        assert!(calls[0].arguments.contains("47*19"));
        assert_eq!(calls[1].name, "get_time");
        assert!(calls[1].arguments.contains("UTC")); // object form serialized
        assert_eq!(calls[1].id, "call_1"); // synthesized when missing
    }

    #[test]
    fn parse_no_tool_calls_is_empty() {
        assert!(parse_message_tool_calls(&json!({ "content": "hi" })).is_empty());
    }

    fn case_expecting(tool: Option<&'static str>, needles: &'static [&'static str]) -> EvalCase {
        EvalCase { id: "t", prompt: "p", expected_tool: tool, must_contain: needles }
    }

    #[test]
    fn grade_passes_right_tool_with_args() {
        let c = case_expecting(Some("calculate"), &["47", "19"]);
        let r = grade(&c, &[call("calculate", "{\"expression\":\"47*19\"}")]);
        assert!(r.passed, "{}", r.detail);
    }

    #[test]
    fn grade_fails_wrong_tool() {
        let c = case_expecting(Some("calculate"), &[]);
        let r = grade(&c, &[call("get_time", "{}")]);
        assert!(!r.passed);
        assert!(r.detail.contains("expected calculate"));
    }

    #[test]
    fn grade_fails_missing_operand() {
        let c = case_expecting(Some("calculate"), &["47", "19"]);
        let r = grade(&c, &[call("calculate", "{\"expression\":\"893\"}")]); // pre-computed
        assert!(!r.passed);
        assert!(r.detail.contains("missing"));
    }

    #[test]
    fn grade_fails_invalid_json_arguments() {
        let c = case_expecting(Some("calculate"), &[]);
        let r = grade(&c, &[call("calculate", "not json")]);
        assert!(!r.passed);
        assert!(r.detail.contains("valid JSON"));
    }

    #[test]
    fn grade_no_tool_expected_passes_on_empty() {
        let c = case_expecting(None, &[]);
        assert!(grade(&c, &[]).passed);
        assert!(!grade(&c, &[call("calculate", "{}")]).passed);
    }

    #[test]
    fn verdict_thresholds() {
        assert_eq!(verdict_for(1.0), "dependable");
        assert_eq!(verdict_for(0.75), "dependable");
        assert_eq!(verdict_for(0.5), "flaky");
        assert_eq!(verdict_for(0.25), "unreliable");
    }

    #[test]
    fn build_report_scores_and_labels() {
        let results = vec![
            CaseResult { id: "a".into(), passed: true, detail: "".into() },
            CaseResult { id: "b".into(), passed: true, detail: "".into() },
            CaseResult { id: "c".into(), passed: true, detail: "".into() },
            CaseResult { id: "d".into(), passed: false, detail: "".into() },
        ];
        let r = build_report("m", results);
        assert_eq!(r.passed, 3);
        assert_eq!(r.total, 4);
        assert_eq!(r.verdict, "dependable"); // 0.75
    }
}
