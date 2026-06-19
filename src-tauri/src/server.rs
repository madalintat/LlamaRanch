use crate::config::{self, Config};
use crate::scanner::Model;
use serde::Deserialize;
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

/// Render a router preset (.ini) listing each model as its own section, pairing
/// vision models with their mmproj. Section name = model id.
pub fn preset_for(models: &[Model]) -> String {
    let mut s = String::from("version = 1\n\n");
    for m in models {
        s.push_str(&format!("[{}]\n", m.id));
        s.push_str(&format!("model = {}\n", m.path));
        if let Some(mm) = &m.mmproj_path {
            s.push_str(&format!("mmproj = {mm}\n"));
        }
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
        "1".into(),
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
}
#[derive(Deserialize)]
struct StatusRaw {
    value: String,
    #[serde(default)]
    failed: bool,
}
#[derive(Deserialize)]
struct ArchRaw {
    input_modalities: Option<Vec<String>>,
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
        let ini = preset_for(&models);
        assert!(ini.contains("[Qwen3-4B]\nmodel = /m/chat/q.gguf\n"));
        assert!(ini.contains("[MiniCPM]\nmodel = /m/vision/v.gguf\nmmproj = /m/vision/mmproj.gguf\n"));
    }

    #[test]
    fn router_args_core_flags_and_idle() {
        let mut cfg = Config::default();
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
}
