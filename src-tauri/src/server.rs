use crate::config::{self, Config, ModelOverride};
use crate::scanner::Model;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Tracks the single persistent `llama-server` router process.
#[derive(Default)]
pub struct ServerState {
    pub child: Option<Child>,
    pub status: String, // "starting" | "running" | "error: <msg>"
    /// Bumped on every (re)start so stale poll threads can detect they are
    /// watching a router that has since been replaced and bail out.
    pub generation: u64,
}

#[derive(Clone)]
pub struct SharedServer(pub Arc<Mutex<ServerState>>);

impl SharedServer {
    pub fn new() -> Self {
        SharedServer(Arc::new(Mutex::new(ServerState {
            status: "starting".into(),
            ..Default::default()
        })))
    }
    pub fn lock(&self) -> std::sync::MutexGuard<'_, ServerState> {
        self.0.lock().unwrap()
    }
}

/// Render the set override keys for one model section (router preset key names).
fn override_lines(o: &ModelOverride) -> String {
    let mut s = String::new();
    if let Some(v) = o.ctx_size { s.push_str(&format!("ctx-size = {v}\n")); }
    if let Some(v) = o.temp { s.push_str(&format!("temp = {v}\n")); }
    if let Some(v) = o.top_p { s.push_str(&format!("top-p = {v}\n")); }
    if let Some(v) = o.top_k { s.push_str(&format!("top-k = {v}\n")); }
    if let Some(v) = o.min_p { s.push_str(&format!("min-p = {v}\n")); }
    if let Some(v) = o.repeat_penalty { s.push_str(&format!("repeat-penalty = {v}\n")); }
    if let Some(v) = o.presence_penalty { s.push_str(&format!("presence-penalty = {v}\n")); }
    if let Some(v) = o.frequency_penalty { s.push_str(&format!("frequency-penalty = {v}\n")); }
    s
}

/// Render a router preset (.ini) listing each model as its own section, pairing
/// vision models with their mmproj. Section name = model id.
pub fn preset_for(
    models: &[Model],
    overrides: &BTreeMap<String, ModelOverride>,
    draft_enabled: bool,
) -> String {
    let mut s = String::from("version = 1\n\n");
    for (idx, m) in models.iter().enumerate() {
        s.push_str(&format!("[{}]\n", m.id));
        s.push_str(&format!("model = {}\n", m.path));
        if let Some(mm) = &m.mmproj_path {
            s.push_str(&format!("mmproj = {mm}\n"));
        }
        // Speculative decoding: pair the model with a small same-family draft
        // from the herd so the router runs them together for faster decode.
        // Best-effort: emits nothing when no suitable draft is installed.
        if draft_enabled {
            if let Some(di) = pick_draft(idx, models) {
                s.push_str(&format!("model-draft = {}\n", models[di].path));
            }
        }
        if let Some(o) = overrides.get(&m.id) {
            s.push_str(&override_lines(o));
        }
        s.push('\n');
    }
    // Overrides for models not in our folder (HF-cached): the router merges a
    // custom `hf-repo` section with its own cached preset and honors our keys.
    for (id, o) in overrides {
        if models.iter().any(|m| m.id == *id) {
            continue;
        }
        s.push_str(&format!("[{id}]\n"));
        s.push_str(&format!("hf-repo = {id}\n"));
        s.push_str(&override_lines(o));
        s.push('\n');
    }
    s
}

// ── Speculative-decoding draft pairing ──────────────────────────────────────

/// A draft must be at most this fraction of the target's parameters. A speculator
/// only wins if it is several times faster to decode than the model it drafts
/// for, so anything larger is not worth pairing.
const DRAFT_MAX_PARAM_RATIO: f32 = 0.4;

/// Characters that separate the tokens of a model name.
const NAME_SEPARATORS: [char; 3] = ['-', '_', ' '];

/// True for a parameter-size token like "8b", "1.7b", or the MoE form "8x7b".
fn is_size_token(tok: &str) -> bool {
    let t = tok.trim_end_matches('b');
    if t == tok || t.is_empty() {
        return false; // didn't end with 'b'
    }
    t.chars().all(|c| c.is_ascii_digit() || c == '.' || c == 'x')
}

/// A coarse model-family signature for draft pairing: the base name lowercased
/// with the parameter-size token, quant, and common instruct suffixes removed,
/// so different sizes of one family share a key ("Qwen3-8B" and "Qwen3-0.6B"
/// both map to "qwen3"). Pure.
pub fn family_key(name: &str) -> String {
    crate::quant::base_name(name)
        .to_lowercase()
        .split(NAME_SEPARATORS)
        .filter(|tok| !tok.is_empty())
        .filter(|tok| !is_size_token(tok))
        .filter(|tok| !matches!(*tok, "it" | "instruct" | "chat" | "base"))
        .collect::<Vec<_>>()
        .join("-")
}

/// Approximate parameter count in billions parsed from a name ("8B" → 8.0,
/// "1.7B" → 1.7), or None when absent. An MoE "AxB" form returns the product.
pub fn param_b(name: &str) -> Option<f32> {
    for tok in name.to_lowercase().split(NAME_SEPARATORS) {
        if is_size_token(tok) {
            let t = tok.trim_end_matches('b');
            if let Some((a, b)) = t.split_once('x') {
                return match (a.parse::<f32>(), b.parse::<f32>()) {
                    (Ok(a), Ok(b)) => Some(a * b),
                    _ => None,
                };
            }
            return t.parse::<f32>().ok();
        }
    }
    None
}

/// Pick the best draft model for the target at `target_idx`: same family, and
/// small enough to be a fast speculator (at most ~40% of the target's
/// parameters). The smallest qualifying model wins. Returns its index, or None
/// when nothing suitable is installed. Pure.
pub fn pick_draft(target_idx: usize, models: &[Model]) -> Option<usize> {
    let target = models.get(target_idx)?;
    let fam = family_key(&target.id);
    // An empty family key (a name that was only a size/quant token) would match
    // every other empty key, pairing unrelated architectures; refuse it. Vision
    // targets carry an mmproj and cannot speculate against a text-only draft.
    if fam.is_empty() || target.mmproj_path.is_some() {
        return None;
    }
    let target_b = param_b(&target.id)?;
    let mut best: Option<(usize, f32)> = None;
    for (i, m) in models.iter().enumerate() {
        if i == target_idx || family_key(&m.id) != fam {
            continue;
        }
        // A draft must share the target's group (same tokenizer/architecture) and
        // be a plain text model, or llama.cpp rejects the pair on a vocab mismatch.
        if m.group != target.group || m.mmproj_path.is_some() {
            continue;
        }
        let Some(b) = param_b(&m.id) else { continue };
        if b > target_b * DRAFT_MAX_PARAM_RATIO {
            continue; // not clearly smaller; a draft must be much faster
        }
        if best.is_none_or(|(_, bb)| b < bb) {
            best = Some((i, b));
        }
    }
    best.map(|(i, _)| i)
}

/// Build router CLI args. `--jinja` and `--fit on` are inherited by every model
/// instance the router spawns, so each model gets correct chat templates and
/// auto-sized GPU layers / context for the available memory.
pub fn router_args(cfg: &Config, preset_path: &str) -> Vec<String> {
    let host = if cfg.expose_to_network {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let mut v = vec![
        "--models-preset".into(),
        preset_path.to_string(),
        "--models-max".into(),
        cfg.models_max.max(1).to_string(),
        "--jinja".into(),
        "--fit".into(),
        "on".into(),
        // Flash attention plus an 8-bit KV cache roughly halve KV-cache memory
        // with no measurable quality or speed loss, which on a low-RAM machine
        // is the difference between a comfortable fit and swapping. These are
        // router-level flags, inherited by every model instance it spawns.
        "--flash-attn".into(),
        "on".into(),
        "--cache-type-k".into(),
        "q8_0".into(),
        "--cache-type-v".into(),
        "q8_0".into(),
        "--props".into(),
        "--host".into(),
        host.into(),
        "--port".into(),
        cfg.port.to_string(),
    ];
    // Cap the context when configured (RAM-aware default), so the KV cache cannot
    // grow to dominate memory. Unset lets --fit size context to device memory.
    if let Some(ctx) = cfg.ctx_size {
        if ctx > 0 {
            v.push("--ctx-size".into());
            v.push(ctx.to_string());
        }
    }
    if cfg.sleep_idle_seconds > 0 {
        v.push("--sleep-idle-seconds".into());
        v.push(cfg.sleep_idle_seconds.to_string());
    }
    v
}

pub fn health_ok(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    ureq::get(&url)
        .timeout(Duration::from_secs(2))
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

pub fn stop(state: &mut ServerState) {
    if let Some(child) = state.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    state.child = None;
    // Drop the PID record so a later launch never reclaims a recycled PID.
    let _ = std::fs::remove_file(router_pid_path());
    state.status = "stopped".into();
}

/// A file alongside the config (e.g. models.ini, router.log).
fn config_sibling(name: &str) -> PathBuf {
    config::config_path()
        .parent()
        .map(|p| p.join(name))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Path of the generated router preset.
pub fn preset_path() -> PathBuf {
    config_sibling("models.ini")
}

/// Where the router's stderr is logged (so the pipe never fills and we can read
/// errors without blocking on a live process).
pub fn router_log_path() -> PathBuf {
    config_sibling("router.log")
}

/// Path of the file recording the current router child PID.
pub fn router_pid_path() -> PathBuf {
    config_sibling("router.pid")
}

/// Decide whether a recorded PID should be reclaimed: only if it's alive
/// (name lookup succeeded) AND looks like our server (guards PID reuse).
fn pid_to_reclaim(recorded: Option<u32>, name_of: impl Fn(u32) -> Option<String>) -> Option<u32> {
    let pid = recorded?;
    if name_of(pid)?.contains("llama-server") {
        Some(pid)
    } else {
        None
    }
}

/// Process name for a PID via `ps` (unix); None if not found. No-op elsewhere.
fn process_name(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let out = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

fn recorded_router_pid() -> Option<u32> {
    std::fs::read_to_string(router_pid_path())
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Kill a stale router from a prior run (dev-reload/crash) so the port is free.
/// Scoped to our recorded PID and guarded by process name, so it can never
/// touch an unrelated process (e.g. a separate Llama app on another port).
pub fn reclaim_stale_router() {
    if let Some(pid) = pid_to_reclaim(recorded_router_pid(), process_name) {
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

fn write_router_pid(pid: u32) {
    let _ = std::fs::write(router_pid_path(), pid.to_string());
}

/// Spawn the router process, logging its stderr to a file. Readiness is
/// reported later via `status`. Bumps `generation` so older poll threads stop.
pub fn start_router(state: &mut ServerState, cfg: &Config, preset_path: &str) -> Result<(), String> {
    stop(state);
    reclaim_stale_router();
    let log = router_log_path();
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stderr = std::fs::File::create(&log)
        .map(std::process::Stdio::from)
        .unwrap_or_else(|_| std::process::Stdio::null());

    let mut cmd = Command::new(&cfg.server_bin);
    cmd.args(router_args(cfg, preset_path))
        .stdout(std::process::Stdio::null())
        .stderr(stderr);
    if !cfg.hf_token.trim().is_empty() {
        cmd.env("HF_TOKEN", cfg.hf_token.trim());
    }
    // don't pop a console window when launching the router on Windows
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch {}: {e}", cfg.server_bin))?;
    write_router_pid(child.id());
    state.child = Some(child);
    state.status = "starting".into();
    state.generation = state.generation.wrapping_add(1);
    Ok(())
}

/// Last ~4 KB of the router log, for surfacing startup/crash errors.
pub fn router_log_tail() -> String {
    let path = router_log_path();
    let Ok(mut f) = std::fs::File::open(&path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(4096);
    let _ = f.seek(SeekFrom::Start(start));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).to_string()
}

// ---- Router HTTP API ----------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct RouterModel {
    pub id: String,
    pub status: String, // unloaded | loading | loaded | sleeping | downloading | error
    pub vision: bool,
    pub need_download: bool,
    pub hf_repo: Option<String>,
}

#[derive(Deserialize)]
struct ModelsResp {
    data: Vec<ModelRaw>,
}
#[derive(Deserialize)]
struct ModelRaw {
    id: String,
    status: Option<StatusRaw>,
    architecture: Option<ArchRaw>,
    #[serde(default)]
    need_download: bool,
}
#[derive(Deserialize)]
struct StatusRaw {
    value: String,
    #[serde(default)]
    failed: bool,
    #[serde(default)]
    args: Vec<String>,
}
#[derive(Deserialize)]
struct ArchRaw {
    input_modalities: Option<Vec<String>>,
}

/// Extract the HF repo id from router args (`--hf-repo <repo>`), if present.
fn hf_repo_from_args(args: &[String]) -> Option<String> {
    args.iter()
        .position(|a| a == "--hf-repo")
        .and_then(|i| args.get(i + 1))
        .cloned()
}

pub fn list_models(port: u16) -> Vec<RouterModel> {
    let url = format!("http://127.0.0.1:{port}/v1/models");
    let resp = match ureq::get(&url).timeout(Duration::from_millis(1500)).call() {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let parsed: ModelsResp = match resp.into_json() {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    parsed
        .data
        .into_iter()
        .map(|m| {
            let args = m.status.as_ref().map(|s| s.args.clone()).unwrap_or_default();
            let status = match m.status {
                Some(s) if s.failed => "error".to_string(),
                Some(s) => s.value,
                None => "unloaded".to_string(),
            };
            let vision = m
                .architecture
                .and_then(|a| a.input_modalities)
                .map(|v| v.iter().any(|x| x == "image"))
                .unwrap_or(false);
            RouterModel {
                id: m.id,
                status,
                vision,
                need_download: m.need_download,
                hf_repo: hf_repo_from_args(&args),
            }
        })
        .collect()
}

fn model_action(port: u16, action: &str, id: &str) -> Result<(), String> {
    // Load can take minutes for large models; unload is near-instant.
    let timeout = if action == "load" {
        Duration::from_secs(300)
    } else {
        Duration::from_secs(15)
    };
    let url = format!("http://127.0.0.1:{port}/models/{action}");
    match ureq::post(&url)
        .timeout(timeout)
        .send_json(serde_json::json!({ "model": id }))
    {
        Ok(_) => Ok(()),
        // The router lazy-loads models (--fit), so by the time we ask it may
        // already be in the desired state. It answers such a redundant request
        // with 400 "model is already running" (load) or a not-running message
        // (unload). The desired end state is already true, so treat these as
        // success rather than surfacing them as a failure to the user.
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            let lower = body.to_lowercase();
            let benign = match action {
                "load" => lower.contains("already running") || lower.contains("already loaded"),
                "unload" => lower.contains("not running") || lower.contains("not loaded") || lower.contains("not found"),
                _ => false,
            };
            let _ = code;
            if benign {
                Ok(())
            } else {
                // Surface the router's own message, not just the status code.
                Err(router_error_message(&body).unwrap_or_else(|| format!("status code {code}")))
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Pull a human-readable message out of the router's JSON error body
/// (`{"error":{"message":"..."}}`), falling back to the raw body if present.
fn router_error_message(body: &str) -> Option<String> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
            return Some(m.to_string());
        }
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn load(port: u16, id: &str) -> Result<(), String> {
    model_action(port, "load", id)
}

pub fn unload(port: u16, id: &str) -> Result<(), String> {
    model_action(port, "unload", id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn preset_pairs_mmproj() {
        let models = vec![
            Model {
                id: "Qwen3-4B".into(),
                name: "Qwen3-4B".into(),
                group: "chat".into(),
                path: "/m/chat/q.gguf".into(),
                size_bytes: 2_400_000_000,
                mmproj_path: None,
            },
            Model {
                id: "MiniCPM".into(),
                name: "MiniCPM".into(),
                group: "vision".into(),
                path: "/m/vision/v.gguf".into(),
                size_bytes: 530_000_000,
                mmproj_path: Some("/m/vision/mmproj.gguf".into()),
            },
        ];
        let ini = preset_for(&models, &std::collections::BTreeMap::new(), false);
        assert!(ini.contains("[Qwen3-4B]\nmodel = /m/chat/q.gguf\n"));
        assert!(ini.contains("[MiniCPM]\nmodel = /m/vision/v.gguf\nmmproj = /m/vision/mmproj.gguf\n"));
    }

    #[test]
    fn override_lines_emits_only_set_keys() {
        use crate::config::ModelOverride;
        let o = ModelOverride { ctx_size: Some(8192), temp: Some(0.7), top_k: Some(40), ..Default::default() };
        let s = override_lines(&o);
        assert!(s.contains("ctx-size = 8192\n"));
        assert!(s.contains("temp = 0.7\n"));
        assert!(s.contains("top-k = 40\n"));
        assert!(!s.contains("top-p"));
        assert!(!s.contains("min-p"));
    }

    #[test]
    fn preset_includes_configured_override() {
        use crate::config::ModelOverride;
        use std::collections::BTreeMap;
        let models = vec![Model {
            id: "Qwen3".into(), name: "Qwen3".into(), group: "chat".into(),
            path: "/m/q.gguf".into(), size_bytes: 2_000_000_000, mmproj_path: None,
        }];
        let mut ov = BTreeMap::new();
        ov.insert("Qwen3".to_string(), ModelOverride { ctx_size: Some(4096), ..Default::default() });
        let ini = preset_for(&models, &ov, false);
        assert!(ini.contains("[Qwen3]\nmodel = /m/q.gguf\nctx-size = 4096\n"));
    }

    #[test]
    fn router_args_core_flags_and_idle() {
        let mut cfg = Config::default();
        cfg.models_max = 1;
        cfg.sleep_idle_seconds = 300;
        let a = router_args(&cfg, "/tmp/p.ini");
        assert!(a.windows(2).any(|w| w == ["--models-preset", "/tmp/p.ini"]));
        assert!(a.windows(2).any(|w| w == ["--models-max", "1"]));
        assert!(a.iter().any(|x| x == "--jinja"));
        assert!(a.windows(2).any(|w| w == ["--fit", "on"]));
        assert!(a.windows(2).any(|w| w == ["--host", "127.0.0.1"]));
        assert!(a.windows(2).any(|w| w == ["--sleep-idle-seconds", "300"]));
        // KV-cache memory optimizations are always on.
        assert!(a.windows(2).any(|w| w == ["--flash-attn", "on"]));
        assert!(a.windows(2).any(|w| w == ["--cache-type-k", "q8_0"]));
        assert!(a.windows(2).any(|w| w == ["--cache-type-v", "q8_0"]));
    }

    #[test]
    fn router_args_ctx_size_capped_when_set() {
        let mut cfg = Config::default();
        cfg.ctx_size = Some(16384);
        let a = router_args(&cfg, "/tmp/p.ini");
        assert!(a.windows(2).any(|w| w == ["--ctx-size", "16384"]));
    }

    #[test]
    fn router_args_no_ctx_size_when_none() {
        let mut cfg = Config::default();
        cfg.ctx_size = None; // let --fit size context
        let a = router_args(&cfg, "/tmp/p.ini");
        assert!(!a.iter().any(|x| x == "--ctx-size"));
    }

    #[test]
    fn router_args_uses_models_max() {
        let mut cfg = Config::default();
        cfg.models_max = 3;
        let a = router_args(&cfg, "/tmp/p.ini");
        assert!(a.windows(2).any(|w| w == ["--models-max", "3"]));
    }

    #[test]
    fn router_args_floors_models_max_to_one() {
        let mut cfg = Config::default();
        cfg.models_max = 0;
        let a = router_args(&cfg, "/tmp/p.ini");
        assert!(a.windows(2).any(|w| w == ["--models-max", "1"]));
    }

    #[test]
    fn router_args_no_idle_when_zero() {
        let mut cfg = Config::default();
        cfg.sleep_idle_seconds = 0; // explicit: default is now 300
        let a = router_args(&cfg, "/tmp/p.ini");
        assert!(!a.iter().any(|x| x == "--sleep-idle-seconds"));
    }

    #[test]
    fn health_ok_true_when_server_returns_200() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 256];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });
        assert!(health_ok(port));
    }

    #[test]
    fn health_ok_false_when_nothing_listening() {
        assert!(!health_ok(1));
    }

    #[test]
    #[cfg(unix)]
    fn stop_kills_child() {
        let child = Command::new("sleep").arg("60").spawn().unwrap();
        let pid = child.id();
        let mut state = ServerState {
            child: Some(child),
            status: "running".into(),
            generation: 1,
        };
        stop(&mut state);
        assert!(state.child.is_none());
        thread::sleep(Duration::from_millis(200));
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .unwrap()
            .success();
        assert!(!alive);
    }

    #[test]
    fn pid_to_reclaim_when_name_matches() {
        let name = |_pid: u32| Some("llama-server".to_string());
        assert_eq!(pid_to_reclaim(Some(123), name), Some(123));
    }

    #[test]
    fn pid_to_reclaim_skips_foreign_process() {
        let name = |_pid: u32| Some("bash".to_string());
        assert_eq!(pid_to_reclaim(Some(123), name), None);
    }

    #[test]
    fn pid_to_reclaim_skips_dead_pid() {
        let name = |_pid: u32| None;
        assert_eq!(pid_to_reclaim(Some(123), name), None);
    }

    #[test]
    fn pid_to_reclaim_none_without_record() {
        assert_eq!(pid_to_reclaim(None, |_p| Some("llama-server".to_string())), None);
    }

    #[test]
    fn hf_repo_parsed_from_args() {
        let args = vec![
            "--jinja".to_string(),
            "--hf-repo".to_string(),
            "ggml-org/gemma".to_string(),
        ];
        assert_eq!(hf_repo_from_args(&args), Some("ggml-org/gemma".to_string()));
    }

    #[test]
    fn hf_repo_none_when_absent() {
        let args = vec!["--jinja".to_string(), "--fit".to_string(), "on".to_string()];
        assert_eq!(hf_repo_from_args(&args), None);
    }

    #[test]
    fn preset_emits_hf_repo_section_for_cached_override() {
        use crate::config::ModelOverride;
        use std::collections::BTreeMap;
        let models = vec![Model {
            id: "Local".into(), name: "Local".into(), group: "chat".into(),
            path: "/m/l.gguf".into(), size_bytes: 2_000_000_000, mmproj_path: None,
        }];
        let mut ov = BTreeMap::new();
        ov.insert("Local".to_string(), ModelOverride { ctx_size: Some(4096), ..Default::default() });
        ov.insert("org/repo:Q4".to_string(), ModelOverride { ctx_size: Some(8192), ..Default::default() });
        let ini = preset_for(&models, &ov, false);
        // local model: plain section + override, NO hf-repo line
        assert!(ini.contains("[Local]\nmodel = /m/l.gguf\nctx-size = 4096\n"));
        assert!(!ini.contains("[Local]\nmodel = /m/l.gguf\nhf-repo"));
        assert!(!ini.contains("hf-repo = Local"));
        // cached override: hf-repo section
        assert!(ini.contains("[org/repo:Q4]\nhf-repo = org/repo:Q4\nctx-size = 8192\n"));
    }

    // ── speculative-decoding draft pairing ──
    fn dmodel(id: &str, path: &str) -> Model {
        Model {
            id: id.into(), name: id.into(), group: "chat".into(),
            path: path.into(), size_bytes: 0, mmproj_path: None,
        }
    }

    #[test]
    fn family_key_strips_size_quant_and_suffix() {
        assert_eq!(family_key("Qwen3-8B-Q4_K_M"), "qwen3");
        assert_eq!(family_key("gemma-3-4b-it"), "gemma-3");
        assert_eq!(family_key("Llama-3.2-3B-Instruct"), "llama-3.2");
    }

    #[test]
    fn param_b_parses_sizes() {
        assert_eq!(param_b("Qwen3-8B-Q4_K_M"), Some(8.0));
        assert_eq!(param_b("model-1.7b"), Some(1.7));
        assert_eq!(param_b("no-size-here"), None);
    }

    #[test]
    fn pick_draft_chooses_smallest_same_family() {
        let models = vec![
            dmodel("Qwen3-8B-Q4_K_M", "/8b"),
            dmodel("Qwen3-1.7B-Q4_K_M", "/1.7b"),
            dmodel("Qwen3-0.6B-Q4_K_M", "/0.6b"),
            dmodel("Llama-3.2-3B", "/llama"),
        ];
        assert_eq!(pick_draft(0, &models), Some(2)); // smallest same-family draft
        assert_eq!(pick_draft(3, &models), None); // llama has no small sibling here
    }

    #[test]
    fn pick_draft_none_when_sibling_not_small_enough() {
        let models = vec![dmodel("Qwen3-8B", "/8b"), dmodel("Qwen3-7B", "/7b")];
        assert_eq!(pick_draft(0, &models), None); // 7B is not <= 40% of 8B
    }

    #[test]
    fn pick_draft_skips_vision_and_cross_group() {
        let mut vision = dmodel("Gemma-3-4B", "/v4");
        vision.group = "vision".into();
        vision.mmproj_path = Some("/mmproj".into());
        let draft = dmodel("Gemma-3-1B", "/c1"); // same family, chat, no mmproj
        let models = vec![vision, draft];
        assert_eq!(pick_draft(0, &models), None); // vision target: drafts incompatible
        assert_eq!(pick_draft(1, &models), None); // only sibling is a different group
    }

    #[test]
    fn pick_draft_none_on_empty_family_key() {
        // Names that are only a size token share an empty family; must not pair.
        let models = vec![dmodel("8B", "/8b"), dmodel("1B", "/1b")];
        assert_eq!(pick_draft(0, &models), None);
    }

    #[test]
    fn preset_emits_model_draft_only_when_enabled() {
        let models = vec![dmodel("Qwen3-8B", "/m/8b.gguf"), dmodel("Qwen3-0.6B", "/m/0.6b.gguf")];
        let on = preset_for(&models, &std::collections::BTreeMap::new(), true);
        assert!(on.contains("[Qwen3-8B]\nmodel = /m/8b.gguf\nmodel-draft = /m/0.6b.gguf\n"));
        let off = preset_for(&models, &std::collections::BTreeMap::new(), false);
        assert!(!off.contains("model-draft"));
    }
}
