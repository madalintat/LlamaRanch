//! The harness brain: routes each chat turn to the best local expert model.
pub mod backend;
pub mod gate;
pub mod pool;
pub mod resolver;
pub mod router;
pub mod tools;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    General,
    Code,
    Reasoning,
    Vision,
}

impl Category {
    /// Catalog group string this category maps to.
    pub fn group(self) -> &'static str {
        match self {
            Category::General => "chat",
            Category::Code => "coding",
            Category::Reasoning => "reasoning",
            Category::Vision => "vision",
        }
    }

    /// Inverse of `group()`: catalog group string → category (default General).
    pub fn from_group(group: &str) -> Category {
        match group {
            "coding" => Category::Code,
            "reasoning" => Category::Reasoning,
            "vision" => Category::Vision,
            _ => Category::General,
        }
    }
}

/// A chat message in the conversation history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// Minimal model facts the resolver needs (derived from the scanner/router list).
#[derive(Clone, Debug, PartialEq)]
pub struct ModelLite {
    pub id: String,
    pub group: String, // "chat" | "coding" | "reasoning" | "vision" | ...
}

#[derive(Clone, Debug, PartialEq)]
pub struct RouteDecision {
    pub category: Category,
    pub reason: String,
}

/// Everything known about an incoming turn before routing.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnContext {
    pub text: String,
    pub has_image: bool,
    pub explicit_group: Option<String>, // user pinned a model → its catalog group
}

/// Fast embedding-similarity gate. Returns a category + confidence, or None to defer.
pub trait EmbeddingGate {
    fn category(&self, text: &str) -> Option<(Category, f32)>;
}

/// Tiny-model fallback classifier for ambiguous text.
pub trait Classifier {
    fn classify(&self, text: &str) -> Category;
}

/// Decides the category for a turn.
pub trait Router {
    fn route(&self, ctx: &TurnContext) -> RouteDecision;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String, // JSON string
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StepResult {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

/// Tool-aware step: stream content via on_token, return content + any tool calls.
pub trait ChatBackend {
    fn step(
        &self,
        model_id: &str,
        messages: &[serde_json::Value],
        tools: &serde_json::Value,
        on_token: &mut dyn FnMut(String),
    ) -> Result<StepResult, String>;
}

/// Ensures a model is loaded and ready before inference.
pub trait Lifecycle {
    fn ensure_loaded(&self, model_id: &str) -> Result<(), String>;
}

use resolver::Resolver;
use std::collections::HashMap;
use std::sync::Mutex;

/// Events streamed to the chat UI for one turn.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrainEvent {
    Routed { model_id: String, category: Category, reason: String },
    Token { text: String },
    Done { usage: Usage },
    Error { message: String },
    ToolCall { name: String, args: String },
    ToolResult { name: String, ok: bool, preview: String },
}

/// In-memory conversation history per session. (Persistence is Phase 5.)
#[derive(Default)]
pub struct Sessions {
    pub map: Mutex<HashMap<String, Vec<Message>>>,
    pub next: std::sync::atomic::AtomicUsize,
}

/// Run one chat turn: route → resolve → ensure-loaded → tool loop. Emits events via `emit`.
/// Pure of Tauri/threads so it is unit-testable with mocked deps.
#[allow(clippy::too_many_arguments)]
pub fn run_turn<E: FnMut(BrainEvent)>(
    router: &dyn Router,
    resolver: &dyn Resolver,
    lifecycle: &dyn Lifecycle,
    backend: &dyn ChatBackend,
    installed: &[ModelLite],
    loaded: &[String],
    history: &mut Vec<Message>,
    ctx: TurnContext,
    override_model: Option<String>,
    registry: &tools::ToolRegistry,
    mut emit: E,
) {
    // Decide (category, reason, model_id) - either a pinned override or routing.
    let (category, reason, model_id) = if let Some(id) = override_model {
        let cat = installed
            .iter()
            .find(|m| m.id == id)
            .map(|m| Category::from_group(&m.group))
            .unwrap_or(Category::General);
        (cat, format!("you picked {id}"), id)
    } else {
        let decision = router.route(&ctx);
        match resolver.resolve(decision.category, installed, loaded) {
            Some(id) => (decision.category, decision.reason, id),
            None => match resolver.resolve(Category::General, installed, loaded) {
                Some(id) => (
                    Category::General,
                    format!("no {} model installed, using general", decision.category.group()),
                    id,
                ),
                None => {
                    emit(BrainEvent::Error { message: "no model installed".into() });
                    return;
                }
            },
        }
    };

    emit(BrainEvent::Routed { model_id: model_id.clone(), category, reason });

    if let Err(e) = lifecycle.ensure_loaded(&model_id) {
        emit(BrainEvent::Error { message: format!("could not load {model_id}: {e}") });
        return;
    }

    // Build the wire message array from existing history, then append the new user turn.
    let mut wire: Vec<serde_json::Value> = history
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    wire.push(serde_json::json!({ "role": "user", "content": ctx.text }));
    let tool_defs = registry.openai_tools();
    const MAX_ITER: usize = 8;

    let mut last_content = String::new();
    for _ in 0..MAX_ITER {
        mask_old_tool_results(&mut wire, WIRE_BUDGET_CHARS);
        let mut on_token = |piece: String| emit(BrainEvent::Token { text: piece });
        let stepres = match backend.step(&model_id, &wire, &tool_defs, &mut on_token) {
            Ok(s) => s,
            Err(e) => { emit(BrainEvent::Error { message: e }); return; }
        };
        if stepres.tool_calls.is_empty() {
            // Clean finish: commit user + assistant as a pair.
            history.push(Message { role: "user".into(), content: ctx.text });
            history.push(Message { role: "assistant".into(), content: stepres.content });
            emit(BrainEvent::Done { usage: Usage::default() });
            return;
        }
        last_content = stepres.content.clone();
        // assistant turn carrying the tool calls (OpenAI shape)
        wire.push(serde_json::json!({
            "role": "assistant",
            "content": stepres.content,
            "tool_calls": stepres.tool_calls.iter().map(|tc| serde_json::json!({
                "id": tc.id, "type": "function",
                "function": { "name": tc.name, "arguments": tc.arguments }
            })).collect::<Vec<_>>()
        }));
        for tc in &stepres.tool_calls {
            emit(BrainEvent::ToolCall { name: tc.name.clone(), args: tc.arguments.clone() });
            let (ok, text) = match registry.run(&tc.name, &tc.arguments) {
                Ok(s) => (true, s),
                Err(e) => (false, format!("error: {e}")),
            };
            let preview: String = text.chars().take(200).collect();
            emit(BrainEvent::ToolResult { name: tc.name.clone(), ok, preview });
            wire.push(serde_json::json!({
                "role": "tool", "tool_call_id": tc.id, "content": text
            }));
        }
    }
    // Hit the iteration cap: commit user + a synthetic assistant message.
    let assistant_content = if last_content.is_empty() {
        "(stopped after 8 tool steps)".into()
    } else {
        last_content
    };
    history.push(Message { role: "user".into(), content: ctx.text });
    history.push(Message { role: "assistant".into(), content: assistant_content });
    emit(BrainEvent::Done { usage: Usage::default() });
}

use crate::commands::AppConfig;
use crate::scanner;
use crate::server;
use backend::RouterChatBackend;
use resolver::DefaultResolver;
use router::DefaultRouter;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Classifier using the small general model via a single, non-streamed call.
/// Public so the HTTP gateway can reuse the exact same routing fallback.
pub struct RouterClassifier { pub port: u16, pub model: String }
impl Classifier for RouterClassifier {
    fn classify(&self, text: &str) -> Category {
        let label = classify_once(self.port, &self.model, text).unwrap_or_default();
        match label.trim().to_lowercase().as_str() {
            s if s.starts_with("code") => Category::Code,
            s if s.starts_with("reason") => Category::Reasoning,
            _ => Category::General,
        }
    }
}

/// One-shot, non-streamed classification call (best-effort).
fn classify_once(port: u16, model: &str, text: &str) -> Option<String> {
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role":"system","content":"Classify the user's request as exactly one word: GENERAL, CODE, or REASONING. Reply with only that word."},
            {"role":"user","content": text}
        ],
        "stream": false,
        "max_tokens": 3,
        "temperature": 0.0
    });
    let resp = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(20))
        .send_json(body).ok()?;
    let v: serde_json::Value = resp.into_json().ok()?;
    Some(v.get("choices")?.get(0)?.get("message")?.get("content")?.as_str()?.to_string())
}

/// Installed models as routing facts (scanned from the models dir). Shared by the
/// in-app chat and the gateway so both route over the same view of what is present.
pub fn installed_models(models_dir: &str) -> Vec<ModelLite> {
    scanner::scan(Path::new(models_dir))
        .into_iter()
        .map(|m| ModelLite { id: m.id, group: m.group })
        .collect()
}

/// Ids of models the router currently has resident (loaded or sleeping).
pub fn loaded_ids(port: u16) -> Vec<String> {
    server::list_models(port)
        .into_iter()
        .filter(|m| m.status == "loaded" || m.status == "sleeping")
        .map(|m| m.id)
        .collect()
}

/// Build the default router (embedding gate + tiny-model classifier). One place
/// so the in-app chat and the gateway share an identical routing policy.
pub fn build_router<'a>(
    port: u16,
    embedding_model: String,
    general_model: String,
    cache: &'a gate::GateCache,
) -> DefaultRouter<gate::EmbedGate<'a>, RouterClassifier> {
    DefaultRouter {
        gate: gate::EmbedGate::new(port, embedding_model, cache),
        classifier: RouterClassifier { port, model: general_model },
    }
}

#[tauri::command]
pub fn chat_new_session(sessions: State<Sessions>) -> String {
    let n = sessions.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let id = format!("s{n}");
    sessions.map.lock().unwrap().insert(id.clone(), Vec::new());
    id
}

#[tauri::command]
pub fn chat_cancel(_session_id: String) {
    // Phase 1: streaming runs to completion; cancel is a no-op placeholder
    // (the UI hides the stop button). Real cancellation is a Phase-2 concern.
}

/// Privacy scope of a tool by name for the Ledger: the two web tools reach the
/// internet; everything else stays on the machine. Mirrors the LOCAL / ONLINE
/// tags in the privacy panel.
fn tool_scope(name: &str) -> &'static str {
    match name {
        "web_fetch" | "web_search" => "online",
        _ => "local",
    }
}

#[tauri::command]
pub fn chat_send<R: Runtime>(
    session_id: String,
    message: String,
    has_image: bool,
    explicit_group: Option<String>,
    explicit_model: Option<String>,
    app: AppHandle<R>,
    cfg: State<AppConfig>,
) {
    let (port, models_dir, general, models_max, embedding_model, allowed_dirs, searxng_url, offline_mode) = {
        let c = cfg.0.lock().unwrap();
        (c.port, c.models_dir.clone(), c.general_model.clone(), c.models_max, c.embedding_model.clone(),
         c.allowed_dirs.clone(), c.searxng_url.clone(), c.offline_mode)
    };

    std::thread::spawn(move || {
        let installed = installed_models(&models_dir);
        let loaded = loaded_ids(port);
        let gate_state = app.state::<gate::GateCache>();
        let router = build_router(port, embedding_model, general.clone(), gate_state.inner());
        let resolver = DefaultResolver;
        let capacity = (models_max as usize).saturating_sub(1).max(1);
        let pool_state = app.state::<pool::Pool>();
        let pinned = if models_max <= 1 { Vec::new() } else { vec![general.clone()] };
        let lifecycle = pool::PoolLifecycle {
            port,
            pinned,
            capacity,
            pool: pool_state.inner(),
        };
        let chat_backend = RouterChatBackend { port };
        let tool_cfg = crate::config::Config {
            allowed_dirs,
            searxng_url,
            offline_mode,
            ..Default::default()
        };
        let registry = tools::ToolRegistry::with_config(&tool_cfg);

        let sessions = app.state::<Sessions>();
        let mut history = sessions.map.lock().unwrap().get(&session_id).cloned().unwrap_or_default();

        let ctx = TurnContext { text: message, has_image, explicit_group };
        let app2 = app.clone();
        let sid = session_id.clone();
        run_turn(&router, &resolver, &lifecycle, &chat_backend, &installed, &loaded, &mut history, ctx,
            explicit_model,
            &registry,
            move |ev| {
                let tel = app2.state::<crate::telemetry::Telemetry>();
                // Record the one routing decision per turn for the Activity view.
                if let BrainEvent::Routed { model_id, category, .. } = &ev {
                    tel.record(model_id, category.group(), false);
                }
                // Record each tool run with its privacy scope for the Ledger.
                if let BrainEvent::ToolResult { name, ok, .. } = &ev {
                    tel.record_tool(name, tool_scope(name), *ok);
                }
                let _ = app2.emit("chat:event", serde_json::json!({ "session": sid, "event": ev }));
            });

        // NOTE: concurrent sends to the SAME session would clobber the slower
        // turn's history (read-then-write). The UI disables send while streaming
        // to prevent this in Phase 1; durable per-session locking is Phase 5.
        sessions.map.lock().unwrap().insert(session_id, history);
    });
}

/// Replace the `content` of older `role:"tool"` messages with a placeholder once the
/// total content size exceeds `budget_chars`, keeping the most recent tool output full
/// and never touching non-tool messages. Operates oldest-first.
///
/// `budget_chars` is approximate: it counts only the `content` field of each message.
pub fn mask_old_tool_results(wire: &mut Vec<serde_json::Value>, budget_chars: usize) {
    const PLACEHOLDER: &str = "[older tool output truncated]";

    // Compute total content chars across all messages.
    let total: usize = wire
        .iter()
        .filter_map(|m| m.get("content")?.as_str())
        .map(|s| s.len())
        .sum();

    if total <= budget_chars {
        return;
    }

    // Collect indices of tool messages oldest → newest.
    let tool_indices: Vec<usize> = wire
        .iter()
        .enumerate()
        .filter(|(_, m)| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
        .map(|(i, _)| i)
        .collect();

    if tool_indices.len() <= 1 {
        // Never truncate the only (or last) tool message.
        return;
    }

    let mut savings_needed = total.saturating_sub(budget_chars);
    // Walk oldest→newest, but never touch the last tool message.
    let truncatable = &tool_indices[..tool_indices.len() - 1];
    for &idx in truncatable {
        if savings_needed == 0 {
            break;
        }
        let content_len = wire[idx]
            .get("content")
            .and_then(|c| c.as_str())
            .map(|s| s.len())
            .unwrap_or(0);
        if content_len > PLACEHOLDER.len() {
            let saved = content_len - PLACEHOLDER.len();
            wire[idx]["content"] = serde_json::Value::String(PLACEHOLDER.to_string());
            savings_needed = savings_needed.saturating_sub(saved);
        }
    }
}

const WIRE_BUDGET_CHARS: usize = 24_000;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::resolver::DefaultResolver;
    use crate::brain::router::DefaultRouter;

    struct StubGate;
    impl EmbeddingGate for StubGate { fn category(&self, _t: &str) -> Option<(Category, f32)> { None } }
    struct StubClassifier;
    impl Classifier for StubClassifier { fn classify(&self, _t: &str) -> Category { Category::General } }
    struct OkLifecycle;
    impl Lifecycle for OkLifecycle { fn ensure_loaded(&self, _m: &str) -> Result<(), String> { Ok(()) } }
    struct EchoBackend;
    impl ChatBackend for EchoBackend {
        fn step(&self, _m: &str, _msgs: &[serde_json::Value], _tools: &serde_json::Value,
                on: &mut dyn FnMut(String)) -> Result<StepResult, String> {
            on("Hi".into());
            on("!".into());
            Ok(StepResult { content: "Hi!".into(), tool_calls: vec![] })
        }
    }
    struct FailBackend;
    impl ChatBackend for FailBackend {
        fn step(&self, _m: &str, _msgs: &[serde_json::Value], _tools: &serde_json::Value,
                _on: &mut dyn FnMut(String)) -> Result<StepResult, String> {
            Err("boom".into())
        }
    }

    fn deps() -> (DefaultRouter<StubGate, StubClassifier>, DefaultResolver, OkLifecycle, Vec<ModelLite>) {
        (
            DefaultRouter { gate: StubGate, classifier: StubClassifier },
            DefaultResolver,
            OkLifecycle,
            vec![ModelLite { id: "gen".into(), group: "chat".into() }],
        )
    }

    fn reg() -> tools::ToolRegistry { tools::ToolRegistry::with_defaults() }

    #[test]
    fn happy_path_emits_routed_tokens_done() {
        let (router, resolver, life, models) = deps();
        let mut hist = vec![];
        let mut evs = vec![];
        run_turn(&router, &resolver, &life, &EchoBackend, &models, &[], &mut hist,
            TurnContext { text: "hello".into(), has_image: false, explicit_group: None },
            None, &reg(),
            |e| evs.push(e));
        assert!(matches!(evs[0], BrainEvent::Routed { .. }));
        assert_eq!(evs[1], BrainEvent::Token { text: "Hi".into() });
        assert_eq!(evs[2], BrainEvent::Token { text: "!".into() });
        assert!(matches!(evs[3], BrainEvent::Done { .. }));
        assert_eq!(hist.last().unwrap().content, "Hi!"); // assistant turn recorded
    }

    #[test]
    fn backend_error_emits_error() {
        let (router, resolver, life, models) = deps();
        let mut hist = vec![];
        let mut evs = vec![];
        run_turn(&router, &resolver, &life, &FailBackend, &models, &[], &mut hist,
            TurnContext { text: "hi".into(), has_image: false, explicit_group: None },
            None, &reg(),
            |e| evs.push(e));
        assert!(matches!(evs.last().unwrap(), BrainEvent::Error { .. }));
    }

    #[test]
    fn no_model_emits_error() {
        let (router, resolver, life, _) = deps();
        let mut hist = vec![];
        let mut evs = vec![];
        run_turn(&router, &resolver, &life, &EchoBackend, &[], &[], &mut hist,
            TurnContext { text: "hi".into(), has_image: false, explicit_group: None },
            None, &reg(),
            |e| evs.push(e));
        assert_eq!(evs, vec![BrainEvent::Error { message: "no model installed".into() }]);
    }

    #[test]
    fn override_model_bypasses_routing() {
        let (router, resolver, life, models) = deps();
        let mut hist = vec![];
        let mut evs = vec![];
        // models has [{id:"gen", group:"chat"}]; pin it explicitly
        run_turn(&router, &resolver, &life, &EchoBackend, &models, &[], &mut hist,
            TurnContext { text: "anything".into(), has_image: false, explicit_group: None },
            Some("gen".to_string()), &reg(),
            |e| evs.push(e));
        match &evs[0] {
            BrainEvent::Routed { model_id, reason, .. } => {
                assert_eq!(model_id, "gen");
                assert!(reason.contains("you picked"));
            }
            other => panic!("expected Routed, got {other:?}"),
        }
    }

    struct ToolThenAnswer { calls: std::cell::Cell<u32> }
    impl ChatBackend for ToolThenAnswer {
        fn step(&self, _m: &str, _msgs: &[serde_json::Value], _tools: &serde_json::Value,
                _on: &mut dyn FnMut(String)) -> Result<StepResult, String> {
            if self.calls.get() == 0 {
                self.calls.set(1);
                Ok(StepResult { content: String::new(), tool_calls: vec![
                    ToolCall { id: "1".into(), name: "calculate".into(), arguments: r#"{"expression":"6*7"}"#.into() }
                ]})
            } else {
                Ok(StepResult { content: "The answer is 42.".into(), tool_calls: vec![] })
            }
        }
    }

    // ── mask_old_tool_results tests ──────────────────────────────────────────

    fn make_tool_msg(id: &str, content: &str) -> serde_json::Value {
        serde_json::json!({ "role": "tool", "tool_call_id": id, "content": content })
    }
    fn make_user_msg(content: &str) -> serde_json::Value {
        serde_json::json!({ "role": "user", "content": content })
    }
    fn make_assistant_msg(content: &str) -> serde_json::Value {
        serde_json::json!({ "role": "assistant", "content": content })
    }

    #[test]
    fn mask_under_budget_wire_unchanged() {
        let mut wire = vec![
            make_user_msg("hello"),
            make_tool_msg("t1", "short result"),
            make_tool_msg("t2", "another result"),
        ];
        let original = wire.clone();
        // budget larger than total content → nothing changes
        mask_old_tool_results(&mut wire, 1_000_000);
        assert_eq!(wire, original);
    }

    #[test]
    fn mask_over_budget_truncates_oldest_keeps_newest_full() {
        // 4 tool messages, each with 1000-char content, plus user/assistant messages.
        let big = "x".repeat(1000);
        let mut wire = vec![
            make_user_msg("user query"),
            make_assistant_msg("thinking…"),
            make_tool_msg("t1", &big),
            make_tool_msg("t2", &big),
            make_tool_msg("t3", &big),
            make_tool_msg("t4", &big),
        ];
        // Total tool content = 4000 chars. Budget = 500 chars → must truncate.
        mask_old_tool_results(&mut wire, 500);

        // The last tool message (t4) must remain untouched.
        assert_eq!(
            wire[5].get("content").unwrap().as_str().unwrap(),
            &big,
            "newest tool result must be kept full"
        );

        // user and assistant messages must be untouched.
        assert_eq!(wire[0].get("content").unwrap().as_str().unwrap(), "user query");
        assert_eq!(wire[1].get("content").unwrap().as_str().unwrap(), "thinking…");

        // At least one older tool message must have been truncated.
        let placeholder = "[older tool output truncated]";
        let truncated_count = wire.iter().filter(|m| {
            m.get("role").and_then(|r| r.as_str()) == Some("tool")
                && m.get("content").and_then(|c| c.as_str()) == Some(placeholder)
        }).count();
        assert!(truncated_count >= 1, "expected at least one truncated tool message");

        // Total content must have decreased (function reduced context rot).
        let total_after: usize = wire
            .iter()
            .filter_map(|m| m.get("content")?.as_str())
            .map(|s| s.len())
            .sum();
        // Since last tool msg alone is 1000 chars which exceeds budget=500, we stop;
        // but total must be less than before (4000 tool chars + user/assistant).
        assert!(total_after < 4000 + "user query".len() + "thinking…".len());
    }

    #[test]
    fn mask_no_tool_messages_unchanged() {
        let mut wire = vec![
            make_user_msg("hi there"),
            make_assistant_msg("hello back"),
        ];
        let original = wire.clone();
        mask_old_tool_results(&mut wire, 1); // budget 1 char, but no tool msgs
        assert_eq!(wire, original);
    }

    #[test]
    fn tool_loop_runs_tool_then_answers() {
        let (router, resolver, life, models) = deps();
        let mut hist = vec![];
        let mut evs = vec![];
        run_turn(&router, &resolver, &life, &ToolThenAnswer { calls: std::cell::Cell::new(0) },
            &models, &[], &mut hist,
            TurnContext { text: "what is 6*7".into(), has_image: false, explicit_group: None },
            None, &reg(), |e| evs.push(e));
        assert!(evs.iter().any(|e| matches!(e, BrainEvent::ToolCall { name, .. } if name == "calculate")));
        assert!(evs.iter().any(|e| matches!(e, BrainEvent::ToolResult { ok: true, .. })));
        assert!(matches!(evs.last().unwrap(), BrainEvent::Done { .. }));
        assert_eq!(hist.last().unwrap().content, "The answer is 42.");
    }
}
