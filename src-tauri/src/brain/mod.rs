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

/// Streams a completion from a model. Synchronous (ureq); calls `on_token` per chunk.
pub trait ChatBackend {
    fn stream(
        &self,
        model_id: &str,
        messages: &[Message],
        on_token: &mut dyn FnMut(String),
    ) -> Result<Usage, String>;
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
}

/// In-memory conversation history per session. (Persistence is Phase 5.)
#[derive(Default)]
pub struct Sessions {
    pub map: Mutex<HashMap<String, Vec<Message>>>,
    pub next: std::sync::atomic::AtomicUsize,
}

/// Run one chat turn: route → resolve → ensure-loaded → stream. Emits events via `emit`.
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
    mut emit: E,
) {
    history.push(Message { role: "user".into(), content: ctx.text.clone() });

    // Decide (category, reason, model_id) — either a pinned override or routing.
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
                    format!("no {} model installed — using general", decision.category.group()),
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

    let mut answer = String::new();
    let mut on_token = |piece: String| {
        answer.push_str(&piece);
        emit(BrainEvent::Token { text: piece });
    };
    match backend.stream(&model_id, history, &mut on_token) {
        Ok(usage) => {
            history.push(Message { role: "assistant".into(), content: answer });
            emit(BrainEvent::Done { usage });
        }
        Err(e) => emit(BrainEvent::Error { message: e }),
    }
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
struct RouterClassifier { port: u16, model: String }
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
    let (port, models_dir, general, models_max, embedding_model) = {
        let c = cfg.0.lock().unwrap();
        (c.port, c.models_dir.clone(), c.general_model.clone(), c.models_max, c.embedding_model.clone())
    };

    std::thread::spawn(move || {
        let installed: Vec<ModelLite> = scanner::scan(Path::new(&models_dir))
            .into_iter()
            .map(|m| ModelLite { id: m.id, group: m.group })
            .collect();
        let loaded: Vec<String> = server::list_models(port)
            .into_iter()
            .filter(|m| m.status == "loaded" || m.status == "sleeping")
            .map(|m| m.id)
            .collect();

        let gate_state = app.state::<gate::GateCache>();
        let router = DefaultRouter {
            gate: gate::EmbedGate::new(port, embedding_model, gate_state.inner()),
            classifier: RouterClassifier { port, model: general.clone() },
        };
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

        let sessions = app.state::<Sessions>();
        let mut history = sessions.map.lock().unwrap().get(&session_id).cloned().unwrap_or_default();

        let ctx = TurnContext { text: message, has_image, explicit_group };
        let app2 = app.clone();
        let sid = session_id.clone();
        run_turn(&router, &resolver, &lifecycle, &chat_backend, &installed, &loaded, &mut history, ctx,
            explicit_model,
            move |ev| {
                let _ = app2.emit("chat:event", serde_json::json!({ "session": sid, "event": ev }));
            });

        // NOTE: concurrent sends to the SAME session would clobber the slower
        // turn's history (read-then-write). The UI disables send while streaming
        // to prevent this in Phase 1; durable per-session locking is Phase 5.
        sessions.map.lock().unwrap().insert(session_id, history);
    });
}

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
        fn stream(&self, _m: &str, _h: &[Message], on: &mut dyn FnMut(String)) -> Result<Usage, String> {
            on("Hi".into());
            on("!".into());
            Ok(Usage { prompt_tokens: 1, completion_tokens: 2 })
        }
    }
    struct FailBackend;
    impl ChatBackend for FailBackend {
        fn stream(&self, _m: &str, _h: &[Message], _on: &mut dyn FnMut(String)) -> Result<Usage, String> {
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

    #[test]
    fn happy_path_emits_routed_tokens_done() {
        let (router, resolver, life, models) = deps();
        let mut hist = vec![];
        let mut evs = vec![];
        run_turn(&router, &resolver, &life, &EchoBackend, &models, &[], &mut hist,
            TurnContext { text: "hello".into(), has_image: false, explicit_group: None },
            None,
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
            None,
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
            None,
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
            Some("gen".to_string()),
            |e| evs.push(e));
        match &evs[0] {
            BrainEvent::Routed { model_id, reason, .. } => {
                assert_eq!(model_id, "gen");
                assert!(reason.contains("you picked"));
            }
            other => panic!("expected Routed, got {other:?}"),
        }
    }
}
