//! The smart-routing HTTP gateway: one OpenAI-compatible endpoint any app can
//! point at to get LlamaRanch routing. Send `model: "auto"` and the gateway picks
//! the best local expert for the prompt, ensures it is loaded, and proxies the
//! request to the llama-server router, streaming the answer back and naming the
//! chosen model in an `X-LlamaRanch-Model` header. A concrete model id passes
//! straight through, so the gateway is a drop-in superset of the raw endpoint.
//!
//! It reuses the brain's routing (router + resolver) but deliberately does NOT
//! run the tool loop: clients run their own loop (the standard OpenAI contract),
//! which keeps LlamaRanch a serving layer, not an agent harness.
use crate::brain::resolver::{DefaultResolver, Resolver};
use crate::brain::{Category, ModelLite, Router, TurnContext};
use crate::commands::AppConfig;
use crate::server;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tiny_http::{Header, Method, Response};

// ---- pure routing helpers (unit-tested) ---------------------------------

/// True when the client wants the gateway to choose the model: a missing,
/// empty, "auto", or "llamaranch" model field.
pub fn is_auto(model: Option<&str>) -> bool {
    match model {
        None => true,
        Some(m) => {
            let m = m.trim().to_lowercase();
            m.is_empty() || m == "auto" || m == "llamaranch"
        }
    }
}

/// Map an explicit category name in the `model` field to a Category, if it is
/// one (so a client can force, e.g., `model: "code"`). None for anything else.
pub fn explicit_category(model: &str) -> Option<Category> {
    match model.trim().to_lowercase().as_str() {
        "general" | "chat" => Some(Category::General),
        "code" | "coding" => Some(Category::Code),
        "reasoning" | "reason" => Some(Category::Reasoning),
        "vision" => Some(Category::Vision),
        _ => None,
    }
}

/// Pull the routing context from an OpenAI request body: the last user message's
/// text, and whether it carries an image (a multimodal content array). Mirrors
/// the signals the in-app chat passes to the router.
pub fn extract_turn(body: &Value) -> TurnContext {
    let mut text = String::new();
    let mut has_image = false;
    if let Some(msgs) = body.get("messages").and_then(|m| m.as_array()) {
        for m in msgs.iter().rev() {
            if m.get("role").and_then(|r| r.as_str()) != Some("user") {
                continue;
            }
            match m.get("content") {
                Some(Value::String(s)) => text = s.clone(),
                Some(Value::Array(parts)) => {
                    let mut buf = String::new();
                    for p in parts {
                        let ty = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        if ty == "text" {
                            if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                                if !buf.is_empty() {
                                    buf.push(' ');
                                }
                                buf.push_str(t);
                            }
                        } else if ty == "image_url" || ty == "image" {
                            has_image = true;
                        }
                    }
                    text = buf;
                }
                _ => {}
            }
            break; // only the last user message matters for routing
        }
    }
    TurnContext { text, has_image, explicit_group: None }
}

/// Decide which model id serves a request. A concrete model id passes through
/// unchanged (routed = false). Otherwise a category is chosen (an explicit
/// category name, else the router's decision for the turn), resolved to an
/// installed model, falling back to General. Returns (model_id, routed,
/// category_group). Errs only when no model is installed at all.
pub fn choose_target(
    body: &Value,
    requested: Option<&str>,
    router: &dyn Router,
    resolver: &dyn Resolver,
    installed: &[ModelLite],
    loaded: &[String],
) -> Result<(String, bool, String), String> {
    // A concrete model id (not "auto", not a category name) passes straight through.
    if let Some(m) = requested {
        if !is_auto(Some(m)) && explicit_category(m).is_none() {
            return Ok((m.to_string(), false, String::new()));
        }
    }
    let category = match requested.and_then(explicit_category) {
        Some(c) => c,
        None => router.route(&extract_turn(body)).category,
    };
    if let Some(id) = resolver.resolve(category, installed, loaded) {
        return Ok((id, true, category.group().to_string()));
    }
    match resolver.resolve(Category::General, installed, loaded) {
        Some(id) => Ok((id, true, Category::General.group().to_string())),
        None => Err("no model installed".to_string()),
    }
}

// ---- HTTP server --------------------------------------------------------

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("static header")
}

fn cors_headers() -> Vec<Header> {
    vec![
        header("Access-Control-Allow-Origin", "*"),
        header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        header("Access-Control-Allow-Headers", "Content-Type, Authorization"),
    ]
}

fn json_error(code: u16, msg: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::json!({ "error": { "message": msg } }).to_string();
    let mut r = Response::from_string(body)
        .with_status_code(code)
        .with_header(header("Content-Type", "application/json"));
    for h in cors_headers() {
        r.add_header(h);
    }
    r
}

/// The router (llama-server) port, read live so config changes are honored.
fn router_port<R: Runtime>(app: &AppHandle<R>) -> u16 {
    app.state::<AppConfig>().0.lock().unwrap().port
}

/// Stream an upstream `ureq` response back to the client verbatim (chunked, so
/// SSE streams flow through token by token), copying the content type and adding
/// CORS plus, when routing chose the model, the `X-LlamaRanch-Model` header.
fn stream_response(req: tiny_http::Request, resp: ureq::Response, chosen_model: Option<&str>) {
    let status = resp.status();
    let ctype = resp
        .header("Content-Type")
        .unwrap_or("application/json")
        .to_string();
    let mut headers = vec![header("Content-Type", &ctype)];
    headers.extend(cors_headers());
    if let Some(m) = chosen_model {
        headers.push(header("X-LlamaRanch-Model", m));
    }
    let reader = resp.into_reader();
    let response = Response::new(
        tiny_http::StatusCode::from(status),
        headers,
        reader,
        None, // unknown length -> chunked transfer
        None,
    );
    let _ = req.respond(response);
}

fn handle_models<R: Runtime>(req: tiny_http::Request, app: &AppHandle<R>) {
    let url = format!("http://127.0.0.1:{}/v1/models", router_port(app));
    match ureq::get(&url).timeout(Duration::from_secs(15)).call() {
        Ok(resp) => stream_response(req, resp, None),
        // Pass a non-2xx upstream response (an error body) through with its status.
        Err(ureq::Error::Status(_, resp)) => stream_response(req, resp, None),
        Err(e) => {
            let _ = req.respond(json_error(502, &format!("router unreachable: {e}")));
        }
    }
}

/// Largest request body we will read. Generous for long-context chats, but a
/// hard ceiling so a runaway or hostile client cannot exhaust memory.
const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

fn handle_chat<R: Runtime>(mut req: tiny_http::Request, app: &AppHandle<R>) {
    let mut body_str = String::new();
    if req.as_reader().take(MAX_BODY_BYTES).read_to_string(&mut body_str).is_err() {
        let _ = req.respond(json_error(400, "could not read request body"));
        return;
    }
    let mut body: Value = match serde_json::from_str(&body_str) {
        Ok(v) => v,
        Err(e) => {
            let _ = req.respond(json_error(400, &format!("invalid JSON: {e}")));
            return;
        }
    };

    let router_port = app.state::<AppConfig>().0.lock().unwrap().port;
    let requested = body.get("model").and_then(|m| m.as_str()).map(str::to_string);

    // A concrete model id needs no routing, so skip the disk scan, the models
    // HTTP call, and the router build entirely; only the routing path pays for them.
    let is_passthrough = requested
        .as_deref()
        .map(|m| !is_auto(Some(m)) && explicit_category(m).is_none())
        .unwrap_or(false);

    let (target, routed, group) = if is_passthrough {
        (requested.clone().unwrap(), false, String::new())
    } else {
        let (models_dir, general, embedding) = {
            let c = app.state::<AppConfig>();
            let c = c.0.lock().unwrap();
            (c.models_dir.clone(), c.general_model.clone(), c.embedding_model.clone())
        };
        let installed = crate::brain::installed_models(&models_dir);
        let loaded = crate::brain::loaded_ids(router_port);
        let gate_state = app.state::<crate::brain::gate::GateCache>();
        let router = crate::brain::build_router(router_port, embedding, general, gate_state.inner());
        let resolver = DefaultResolver;
        match choose_target(&body, requested.as_deref(), &router, &resolver, &installed, &loaded) {
            Ok(t) => t,
            Err(e) => {
                let _ = req.respond(json_error(503, &e));
                return;
            }
        }
    };

    // Record routed picks (not passthrough concrete ids) for the Activity view.
    if routed {
        app.state::<crate::telemetry::Telemetry>().record(&target, &group, true);
    }

    // Rewrite the model and ensure it is loaded before forwarding (smart load).
    body["model"] = Value::String(target.clone());
    if let Err(e) = server::load(router_port, &target) {
        let _ = req.respond(json_error(502, &format!("could not load {target}: {e}")));
        return;
    }

    let model_header = if routed { Some(target.as_str()) } else { None };
    let url = format!("http://127.0.0.1:{router_port}/v1/chat/completions");
    match ureq::post(&url).timeout(Duration::from_secs(3600)).send_json(body) {
        Ok(resp) => stream_response(req, resp, model_header),
        // Pass the router's own error response (status + body) straight through.
        Err(ureq::Error::Status(_, resp)) => stream_response(req, resp, model_header),
        Err(e) => {
            let _ = req.respond(json_error(502, &format!("router error: {e}")));
        }
    }
}

fn handle<R: Runtime>(req: tiny_http::Request, app: &AppHandle<R>) {
    let method = req.method().clone();
    let path = req.url().split('?').next().unwrap_or("").to_string();
    match (method, path.as_str()) {
        (Method::Options, _) => {
            let mut r = Response::empty(204);
            for h in cors_headers() {
                r.add_header(h);
            }
            let _ = req.respond(r);
        }
        (Method::Get, "/health") => {
            let mut r = Response::from_string("ok");
            r.add_header(header("Access-Control-Allow-Origin", "*"));
            let _ = req.respond(r);
        }
        (Method::Get, "/v1/models") => handle_models(req, app),
        (Method::Post, "/v1/chat/completions") => handle_chat(req, app),
        _ => {
            let _ = req.respond(json_error(404, "not found"));
        }
    }
}

/// Start the gateway HTTP server on its own thread when enabled. Binds loopback
/// unless the app is set to expose to the network, mirroring the router. Each
/// request is handled on its own thread so a long stream never blocks others.
pub fn start_gateway<R: Runtime>(app: &AppHandle<R>) {
    let (enabled, port, expose) = {
        let c = app.state::<AppConfig>();
        let c = c.0.lock().unwrap();
        (c.gateway_enabled, c.gateway_port, c.expose_to_network)
    };
    if !enabled {
        return;
    }
    let host = if expose { "0.0.0.0" } else { "127.0.0.1" };
    let addr = format!("{host}:{port}");
    let app = app.clone();
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("llamaranch gateway: could not bind {addr}: {e}");
                return;
            }
        };
        for req in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || handle(req, &app));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::{RouteDecision, Router};
    use serde_json::json;

    struct StubRouter(Category);
    impl Router for StubRouter {
        fn route(&self, _ctx: &TurnContext) -> RouteDecision {
            RouteDecision { category: self.0, reason: "stub".into() }
        }
    }

    fn installed() -> Vec<ModelLite> {
        vec![
            ModelLite { id: "gen".into(), group: "chat".into() },
            ModelLite { id: "coder".into(), group: "coding".into() },
        ]
    }

    #[test]
    fn is_auto_recognizes_auto_and_blank() {
        assert!(is_auto(None));
        assert!(is_auto(Some("")));
        assert!(is_auto(Some("  AUTO ")));
        assert!(is_auto(Some("llamaranch")));
        assert!(!is_auto(Some("Qwen3-4B")));
    }

    #[test]
    fn explicit_category_maps_known_names() {
        assert_eq!(explicit_category("code"), Some(Category::Code));
        assert_eq!(explicit_category("CODING"), Some(Category::Code));
        assert_eq!(explicit_category("vision"), Some(Category::Vision));
        assert_eq!(explicit_category("Qwen3-4B"), None);
    }

    #[test]
    fn extract_turn_reads_last_user_string() {
        let body = json!({"messages":[
            {"role":"user","content":"first"},
            {"role":"assistant","content":"reply"},
            {"role":"user","content":"second"}
        ]});
        let t = extract_turn(&body);
        assert_eq!(t.text, "second");
        assert!(!t.has_image);
    }

    #[test]
    fn extract_turn_handles_multimodal_array() {
        let body = json!({"messages":[{"role":"user","content":[
            {"type":"text","text":"describe this"},
            {"type":"image_url","image_url":{"url":"data:..."}}
        ]}]});
        let t = extract_turn(&body);
        assert_eq!(t.text, "describe this");
        assert!(t.has_image);
    }

    #[test]
    fn choose_target_routes_auto_to_resolved_expert() {
        let body = json!({"messages":[{"role":"user","content":"write code"}]});
        let (id, routed, group) = choose_target(
            &body, Some("auto"), &StubRouter(Category::Code), &DefaultResolver, &installed(), &[],
        ).unwrap();
        assert_eq!(id, "coder");
        assert!(routed);
        assert_eq!(group, "coding");
    }

    #[test]
    fn choose_target_passes_concrete_id_through() {
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        let (id, routed, _) = choose_target(
            &body, Some("gen"), &StubRouter(Category::Code), &DefaultResolver, &installed(), &[],
        ).unwrap();
        assert_eq!(id, "gen");
        assert!(!routed); // concrete id is a passthrough, not a routed pick
    }

    #[test]
    fn choose_target_explicit_category_falls_back_to_general() {
        // Force vision, but no vision model installed -> General fallback.
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        let (id, _routed, group) = choose_target(
            &body, Some("vision"), &StubRouter(Category::Code), &DefaultResolver, &installed(), &[],
        ).unwrap();
        assert_eq!(id, "gen");
        assert_eq!(group, "chat");
    }

    #[test]
    fn choose_target_errors_when_nothing_installed() {
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        assert!(choose_target(
            &body, Some("auto"), &StubRouter(Category::Code), &DefaultResolver, &[], &[],
        ).is_err());
    }
}
