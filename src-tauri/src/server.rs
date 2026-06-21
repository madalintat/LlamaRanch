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
pub fn preset_for(models: &[Model], overrides: &BTreeMap<String, ModelOverride>) -> String {
    let mut s = String::from("version = 1\n\n");
    for m in models {
        s.push_str(&format!("[{}]\n", m.id));
        s.push_str(&format!("model = {}\n", m.path));
        if let Some(mm) = &m.mmproj_path {
            s.push_str(&format!("mmproj = {mm}\n"));
        }
        if let Some(o) = overrides.get(&m.id) {
            s.push_str(&override_lines(o));
        }
        s.push('\n');
    }
    // Overrides for models not in our folder (HF-cached): the router merges a
    // custom `hf-repo` section with its own cached preset and honors our keys.
    let local_ids: std::collections::HashSet<&str> = models.iter().map(|m| m.id.as_str()).collect();
    for (id, o) in overrides {
        if local_ids.contains(id.as_str()) {
            continue;
        }
        s.push_str(&format!("[{id}]\n"));
        s.push_str(&format!("hf-repo = {id}\n"));
        s.push_str(&override_lines(o));
        s.push('\n');
    }
    s
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
        "--props".into(),
        "--host".into(),
        host.into(),
        "--port".into(),
        cfg.port.to_string(),
    ];
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
    let url = format!("http://127.0.0.1:{port}/models/{action}");
    ureq::post(&url)
        .timeout(Duration::from_secs(10))
        .send_json(serde_json::json!({ "model": id }))
        .map(|_| ())
        .map_err(|e| e.to_string())
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
        let ini = preset_for(&models, &std::collections::BTreeMap::new());
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
        let ini = preset_for(&models, &ov);
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
        let cfg = Config::default(); // sleep_idle_seconds = 0
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
        let ini = preset_for(&models, &ov);
        // local model: plain section + override, NO hf-repo line
        assert!(ini.contains("[Local]\nmodel = /m/l.gguf\nctx-size = 4096\n"));
        assert!(!ini.contains("[Local]\nmodel = /m/l.gguf\nhf-repo"));
        // cached override: hf-repo section
        assert!(ini.contains("[org/repo:Q4]\nhf-repo = org/repo:Q4\nctx-size = 8192\n"));
    }
}
