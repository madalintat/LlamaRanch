# LlamaRanch MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Linux tray app that discovers local llama.cpp GGUF models, starts/stops a single `llama-server` with hardware-aware flags, and surfaces the OpenAI-compatible endpoint + WebUI.

**Architecture:** Tauri v2. A Rust backend manages the `llama-server` child process, scans the models directory, computes `-ngl` from model size, and exposes Tauri commands + a tray icon. A vanilla-TS frontend renders a small panel window that drives those commands.

**Tech Stack:** Tauri v2, Rust 1.94, vanilla TypeScript + Vite, Node 20. Backend crates: serde, serde_json, dirs, ureq. Dev: tempfile.

**Project root:** `/home/madalin/LlamaRanch` (standalone, no GitHub).

**Key external paths (defaults):**
- llama-server: `/home/madalin/llama.cpp/build/bin/llama-server`
- models dir: `/home/madalin/llama.cpp/models`
- default port: `2276`

---

## File Structure

```
~/LlamaRanch/
├── package.json            # frontend deps + tauri scripts
├── index.html              # panel shell
├── vite.config.ts
├── tsconfig.json
├── assets/llamaranch.svg   # provided icon source
├── scripts/
│   ├── gen-icons.sh        # SVG -> PNG icon set
│   ├── llamaranch.desktop  # launcher
│   └── install-desktop.sh  # copies .desktop + icon to ~/.local/share
├── src/                    # frontend (vanilla TS)
│   ├── main.ts             # panel logic
│   └── styles.css
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/              # generated PNGs
    └── src/
        ├── main.rs         # builder, state, tray, commands registration, exit handler
        ├── config.rs       # Config struct, load/save
        ├── scanner.rs      # Model struct, scan(root)
        ├── launch.rs       # ngl_for, placement_for, flags_for
        ├── server.rs       # ServerState, start/stop, health_ok
        └── commands.rs     # #[tauri::command] wrappers
```

Module responsibilities are isolated: `config`, `scanner`, `launch` are pure and unit-tested; `server` owns process + health; `commands` is a thin adapter; `main` wires Tauri + tray.

---

## Task 0: Scaffold the Tauri project

**Files:** creates the whole `src-tauri/` + frontend skeleton.

- [ ] **Step 1: Scaffold with the Tauri vanilla-TS template**

Run (from `/home/madalin`):
```bash
cd /home/madalin/LlamaRanch
npm create tauri-app@latest . -- --template vanilla-ts --manager npm --identifier com.llamaranch.app
```
If the directory-not-empty prompt blocks non-interactively, scaffold in a temp dir and move files in:
```bash
cd /tmp && npm create tauri-app@latest llamaranch-scaffold -- --template vanilla-ts --manager npm --identifier com.llamaranch.app
cp -rn /tmp/llamaranch-scaffold/. /home/madalin/LlamaRanch/
```

- [ ] **Step 2: Install JS deps**

Run: `cd /home/madalin/LlamaRanch && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Verify a dev build compiles**

Run: `cd /home/madalin/LlamaRanch && npm run tauri build -- --no-bundle 2>&1 | tail -20`
Expected: Rust compiles and a binary is produced under `src-tauri/target/release/`. (We use build, not dev, because dev needs a display; this just proves the toolchain works.)

- [ ] **Step 4: Commit**

```bash
cd /home/madalin/LlamaRanch && git init && git add -A && git commit -m "chore: scaffold Tauri vanilla-ts project"
```

---

## Task 1: Backend dependencies + module skeleton

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/config.rs`, `scanner.rs`, `launch.rs`, `server.rs`, `commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add crates to `src-tauri/Cargo.toml`**

Under `[dependencies]` add (keep the template's existing `tauri`, `serde`, `serde_json` lines; merge features into the `tauri` line):
```toml
tauri = { version = "2", features = ["tray-icon", "image-png"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
dirs = "5"
ureq = "2"
```
Under (add if missing) `[dev-dependencies]`:
```toml
tempfile = "3"
```

- [ ] **Step 2: Declare modules in `src-tauri/src/main.rs`**

At the top of `main.rs` (above `fn main`), add:
```rust
mod config;
mod scanner;
mod launch;
mod server;
mod commands;
```
Create the five files as empty stubs (`touch`) so the crate compiles:
```bash
cd /home/madalin/LlamaRanch/src-tauri/src && touch config.rs scanner.rs launch.rs server.rs commands.rs
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo build 2>&1 | tail -15`
Expected: builds (empty modules are valid).

- [ ] **Step 4: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "chore: add backend deps and module skeleton"
```

---

## Task 2: Config module (TDD)

**Files:**
- Modify: `src-tauri/src/config.rs`

- [ ] **Step 1: Write the failing tests**

Put in `config.rs`:
```rust
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub port: u16,
    pub models_dir: String,
    pub server_bin: String,
    pub expose_to_network: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: 2276,
            models_dir: "/home/madalin/llama.cpp/models".into(),
            server_bin: "/home/madalin/llama.cpp/build/bin/llama-server".into(),
            expose_to_network: false,
        }
    }
}

pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("llamaranch/config.json")
}

pub fn load_from(path: &Path) -> Config {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_to(path: &Path, cfg: &Config) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(cfg).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_returns_default() {
        let p = std::path::Path::new("/nonexistent/llamaranch/x.json");
        assert_eq!(load_from(p), Config::default());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let mut cfg = Config::default();
        cfg.port = 9999;
        cfg.expose_to_network = true;
        save_to(&p, &cfg).unwrap();
        assert_eq!(load_from(&p), cfg);
    }
}
```

- [ ] **Step 2: Run tests to verify they pass (implementation is inline)**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo test config:: 2>&1 | tail -15`
Expected: 2 passed. (Code + tests written together here because the logic is trivial; if you prefer strict red-first, comment out the function bodies, see them fail, then restore.)

- [ ] **Step 3: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "feat: config load/save with defaults"
```

---

## Task 3: Scanner module (TDD)

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: Write the failing test first**

Put in `scanner.rs`:
```rust
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub group: String,
    pub path: String,
    pub size_bytes: u64,
    pub mmproj_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(p: &Path, bytes: usize) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn scans_grouped_models_and_pairs_mmproj() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("chat/Qwen3-4B-Q4_K_M.gguf"), 10);
        touch(&root.join("vision/MiniCPM-V-4.6-Q4_K_M.gguf"), 20);
        touch(&root.join("vision/mmproj-MiniCPM-V-4.6-Q8_0.gguf"), 5);
        touch(&root.join("vision/notes.txt"), 3); // ignored

        let mut models = scan(root);
        models.sort_by(|a, b| a.id.cmp(&b.id));

        assert_eq!(models.len(), 2);
        let chat = models.iter().find(|m| m.group == "chat").unwrap();
        assert_eq!(chat.id, "Qwen3-4B-Q4_K_M");
        assert_eq!(chat.size_bytes, 10);
        assert_eq!(chat.mmproj_path, None);

        let vision = models.iter().find(|m| m.group == "vision").unwrap();
        assert!(vision.mmproj_path.as_ref().unwrap().ends_with("mmproj-MiniCPM-V-4.6-Q8_0.gguf"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo test scanner:: 2>&1 | tail -15`
Expected: FAIL - `scan` not found.

- [ ] **Step 3: Implement `scan`**

Add to `scanner.rs` (above the tests):
```rust
fn collect_gguf(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_gguf(&p, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("gguf") {
                out.push(p);
            }
        }
    }
}

fn is_mmproj(p: &Path) -> bool {
    p.file_name()
        .and_then(|s| s.to_str())
        .map(|n| n.starts_with("mmproj"))
        .unwrap_or(false)
}

pub fn scan(root: &Path) -> Vec<Model> {
    let mut files = Vec::new();
    collect_gguf(root, &mut files);

    let mmprojs: Vec<&PathBuf> = files.iter().filter(|p| is_mmproj(p)).collect();

    files
        .iter()
        .filter(|p| !is_mmproj(p))
        .map(|p| {
            let id = p.file_stem().unwrap().to_string_lossy().to_string();
            let group = p
                .parent()
                .and_then(|d| d.file_name())
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "models".into());
            let size_bytes = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let mmproj_path = mmprojs
                .iter()
                .find(|mm| mm.parent() == p.parent())
                .map(|mm| mm.to_string_lossy().to_string());
            Model {
                id: id.clone(),
                name: id,
                group,
                path: p.to_string_lossy().to_string(),
                size_bytes,
                mmproj_path,
            }
        })
        .collect()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo test scanner:: 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "feat: scan models dir grouped, pair mmproj"
```

---

## Task 4: Launch flags heuristic (TDD)

**Files:**
- Modify: `src-tauri/src/launch.rs`

- [ ] **Step 1: Write the failing tests first**

Put in `launch.rs`:
```rust
use crate::config::Config;
use crate::scanner::Model;

const GB: u64 = 1_000_000_000;

#[cfg(test)]
mod tests {
    use super::*;

    fn model(size: u64, mmproj: Option<&str>) -> Model {
        Model {
            id: "m".into(),
            name: "m".into(),
            group: "chat".into(),
            path: "/models/m.gguf".into(),
            size_bytes: size,
            mmproj_path: mmproj.map(|s| s.to_string()),
        }
    }

    #[test]
    fn ngl_buckets() {
        assert_eq!(ngl_for(2 * GB), 99);
        assert_eq!(ngl_for(5 * GB), 18);
        assert_eq!(ngl_for(18 * GB), 6);
    }

    #[test]
    fn placement_buckets() {
        assert_eq!(placement_for(2 * GB), "GPU");
        assert_eq!(placement_for(5 * GB), "Partial");
        assert_eq!(placement_for(18 * GB), "CPU");
    }

    #[test]
    fn flags_include_core_and_mmproj() {
        let cfg = Config::default();
        let f = flags_for(&model(2 * GB, Some("/models/mmproj.gguf")), &cfg);
        assert!(f.windows(2).any(|w| w == ["-m", "/models/m.gguf"]));
        assert!(f.windows(2).any(|w| w == ["--host", "127.0.0.1"]));
        assert!(f.windows(2).any(|w| w == ["--port", "2276"]));
        assert!(f.windows(2).any(|w| w == ["-ngl", "99"]));
        assert!(f.windows(2).any(|w| w == ["--mmproj", "/models/mmproj.gguf"]));
    }

    #[test]
    fn expose_flips_host() {
        let mut cfg = Config::default();
        cfg.expose_to_network = true;
        let f = flags_for(&model(2 * GB, None), &cfg);
        assert!(f.windows(2).any(|w| w == ["--host", "0.0.0.0"]));
        assert!(!f.iter().any(|x| x == "--mmproj"));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo test launch:: 2>&1 | tail -15`
Expected: FAIL - functions not found.

- [ ] **Step 3: Implement the functions**

Add to `launch.rs` (above the tests):
```rust
pub fn ngl_for(size_bytes: u64) -> u32 {
    if size_bytes <= 3 * GB {
        99
    } else if size_bytes <= 6 * GB {
        18
    } else {
        6
    }
}

pub fn placement_for(size_bytes: u64) -> &'static str {
    if size_bytes <= 3 * GB {
        "GPU"
    } else if size_bytes <= 6 * GB {
        "Partial"
    } else {
        "CPU"
    }
}

pub fn flags_for(model: &Model, cfg: &Config) -> Vec<String> {
    let host = if cfg.expose_to_network {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let mut v = vec![
        "-m".into(),
        model.path.clone(),
        "--host".into(),
        host.into(),
        "--port".into(),
        cfg.port.to_string(),
        "--ctx-size".into(),
        "4096".into(),
        "-ngl".into(),
        ngl_for(model.size_bytes).to_string(),
    ];
    if let Some(mm) = &model.mmproj_path {
        v.push("--mmproj".into());
        v.push(mm.clone());
    }
    v
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo test launch:: 2>&1 | tail -15`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "feat: hardware-aware launch flags heuristic"
```

---

## Task 5: Server lifecycle + health check (TDD)

**Files:**
- Modify: `src-tauri/src/server.rs`

- [ ] **Step 1: Write the failing tests first**

Put in `server.rs`:
```rust
use std::io::{Read, Write};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct ServerState {
    pub child: Option<Child>,
    pub model_id: Option<String>,
    pub status: String, // "idle" | "starting" | "running" | "error: <msg>"
}

pub type SharedServer = Mutex<ServerState>;

pub fn health_ok(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/health", port);
    ureq::get(&url)
        .timeout(Duration::from_secs(2))
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

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
        assert!(!health_ok(1)); // port 1: nothing there
    }

    #[test]
    fn stop_kills_child() {
        let child = Command::new("sleep").arg("60").spawn().unwrap();
        let pid = child.id();
        let mut state = ServerState {
            child: Some(child),
            model_id: Some("x".into()),
            status: "running".into(),
        };
        stop(&mut state);
        assert!(state.child.is_none());
        assert_eq!(state.status, "idle");
        // process should be gone
        thread::sleep(Duration::from_millis(200));
        let alive = Command::new("kill").args(["-0", &pid.to_string()]).status().unwrap().success();
        assert!(!alive);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo test server:: 2>&1 | tail -20`
Expected: FAIL - `stop` not found.

- [ ] **Step 3: Implement `stop` and `start`**

Add to `server.rs` (above the tests):
```rust
pub fn stop(state: &mut ServerState) {
    if let Some(child) = state.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    state.child = None;
    state.model_id = None;
    state.status = "idle".into();
}

/// Spawn llama-server. Returns Ok once the process is spawned; readiness is
/// reported later via `status` (caller polls). On spawn failure returns Err.
pub fn start(
    state: &mut ServerState,
    bin: &str,
    args: &[String],
    model_id: &str,
) -> Result<(), String> {
    stop(state);
    let child = Command::new(bin)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch {bin}: {e}"))?;
    state.child = Some(child);
    state.model_id = Some(model_id.to_string());
    state.status = "starting".into();
    Ok(())
}

/// Read whatever stderr the child has produced (used for error reporting).
pub fn drain_stderr(state: &mut ServerState) -> String {
    let mut out = String::new();
    if let Some(child) = state.child.as_mut() {
        if let Some(err) = child.stderr.as_mut() {
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf);
            out = String::from_utf8_lossy(&buf).to_string();
        }
    }
    out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo test server:: 2>&1 | tail -20`
Expected: PASS (3 tests). (`health_ok_false_when_nothing_listening` and the 200 test exercise the HTTP path; `stop_kills_child` exercises process management.)

- [ ] **Step 5: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "feat: server start/stop + health check"
```

---

## Task 6: Tauri commands layer

**Files:**
- Modify: `src-tauri/src/commands.rs`

No unit tests here (thin glue over tested modules); verified via the build + manual run.

- [ ] **Step 1: Implement the command wrappers**

Put in `commands.rs`:
```rust
use crate::config::{self, Config};
use crate::launch;
use crate::scanner::{self, Model};
use crate::server::{self, SharedServer};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

pub struct AppConfig(pub Mutex<Config>);

#[derive(Serialize)]
pub struct ModelView {
    #[serde(flatten)]
    pub model: Model,
    pub placement: String,
}

#[derive(Serialize)]
pub struct StatusView {
    pub status: String,
    pub model_id: Option<String>,
    pub endpoint: String,
}

fn endpoint(cfg: &Config) -> String {
    format!("http://127.0.0.1:{}/v1", cfg.port)
}

#[tauri::command]
pub fn list_models(cfg: State<AppConfig>) -> Vec<ModelView> {
    let cfg = cfg.0.lock().unwrap().clone();
    scanner::scan(Path::new(&cfg.models_dir))
        .into_iter()
        .map(|m| {
            let placement = launch::placement_for(m.size_bytes).to_string();
            ModelView { model: m, placement }
        })
        .collect()
}

#[tauri::command]
pub fn server_status(srv: State<SharedServer>, cfg: State<AppConfig>) -> StatusView {
    let s = srv.lock();
    let cfg = cfg.0.lock().unwrap();
    StatusView {
        status: s.status.clone(),
        model_id: s.model_id.clone(),
        endpoint: endpoint(&cfg),
    }
}

#[tauri::command]
pub fn start_server(
    model_id: String,
    srv: State<SharedServer>,
    cfg: State<AppConfig>,
) -> Result<(), String> {
    let cfg = cfg.0.lock().unwrap().clone();
    let model = scanner::scan(Path::new(&cfg.models_dir))
        .into_iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("model not found: {model_id}"))?;
    let args = launch::flags_for(&model, &cfg);

    {
        let mut s = srv.lock();
        server::start(&mut s, &cfg.server_bin, &args, &model_id)?;
    }

    // Poll /health in the background; flip status to running or error.
    let srv_inner = srv.inner().clone_handle();
    let port = cfg.port;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if Instant::now() > deadline {
                let mut s = srv_inner.lock();
                let err = server::drain_stderr(&mut s);
                server::stop(&mut s);
                s.status = format!("error: timed out starting llama-server\n{err}");
                break;
            }
            if server::health_ok(port) {
                let mut s = srv_inner.lock();
                if s.child.is_some() {
                    s.status = "running".into();
                }
                break;
            }
            // detect early crash
            {
                let mut s = srv_inner.lock();
                if let Some(child) = s.child.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        let err = server::drain_stderr(&mut s);
                        server::stop(&mut s);
                        s.status = format!("error: llama-server exited\n{err}");
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(800));
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_server(srv: State<SharedServer>) {
    let mut s = srv.lock();
    server::stop(&mut s);
}

#[tauri::command]
pub fn open_webui(cfg: State<AppConfig>) -> Result<(), String> {
    let port = cfg.0.lock().unwrap().port;
    let url = format!("http://127.0.0.1:{}", port);
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_config(cfg: State<AppConfig>) -> Config {
    cfg.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_config(new_cfg: Config, cfg: State<AppConfig>) -> Result<(), String> {
    *cfg.0.lock().unwrap() = new_cfg.clone();
    config::save_to(&config::config_path(), &new_cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn llama_cpp_version(cfg: State<AppConfig>) -> String {
    let bin = cfg.0.lock().unwrap().server_bin.clone();
    std::process::Command::new(&bin)
        .arg("--version")
        .output()
        .ok()
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stderr);
            s.lines().next().unwrap_or("").to_string()
        })
        .unwrap_or_else(|| "unknown".into())
}
```

- [ ] **Step 2: Add the `SharedServer` handle helper**

The background thread needs a cloneable handle to the shared server. In `server.rs`, change the shared type to an `Arc<Mutex<..>>` wrapper and add `clone_handle`. Replace the `SharedServer` definition in `server.rs` with:
```rust
use std::sync::Arc;

#[derive(Clone)]
pub struct SharedServer(pub Arc<Mutex<ServerState>>);

impl SharedServer {
    pub fn new() -> Self {
        SharedServer(Arc::new(Mutex::new(ServerState {
            status: "idle".into(),
            ..Default::default()
        })))
    }
    pub fn lock(&self) -> std::sync::MutexGuard<'_, ServerState> {
        self.0.lock().unwrap()
    }
    pub fn clone_handle(&self) -> SharedServer {
        self.clone()
    }
}
```
Then in `commands.rs` replace `srv: State<SharedServer>` usages: `srv.lock()` already works via the method; replace `srv.inner().clone_handle()` with `srv.inner().clone_handle()` (now valid). Remove the earlier `type SharedServer = Mutex<ServerState>;` line from Task 5.

- [ ] **Step 3: Verify it compiles**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo build 2>&1 | tail -25`
Expected: compiles. Fix any signature mismatch the compiler flags (the compiler is the spec here).

- [ ] **Step 4: Re-run all tests**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo test 2>&1 | tail -20`
Expected: all previous tests still pass.

- [ ] **Step 5: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "feat: tauri commands layer"
```

---

## Task 7: Wire main.rs - state, commands, tray, exit handler

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Configure the window as a small panel in `tauri.conf.json`**

In the `app.windows[0]` object set:
```json
{
  "title": "LlamaRanch",
  "width": 420,
  "height": 560,
  "resizable": false,
  "decorations": true,
  "visible": false
}
```
Ensure `app.security.capabilities` includes `"default"` (template default).

- [ ] **Step 2: Implement `main.rs`**

Replace `main.rs` body (keep the `mod` lines from Task 1) with:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod scanner;
mod launch;
mod server;
mod commands;

use commands::AppConfig;
use server::SharedServer;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

fn main() {
    let cfg = config::load_from(&config::config_path());
    let shared = SharedServer::new();

    tauri::Builder::default()
        .manage(AppConfig(Mutex::new(cfg)))
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            commands::list_models,
            commands::server_status,
            commands::start_server,
            commands::stop_server,
            commands::open_webui,
            commands::get_config,
            commands::set_config,
            commands::llama_cpp_version,
        ])
        .setup(|app| {
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show LlamaRanch", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LlamaRanch")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        if let Some(srv) = app.try_state::<SharedServer>() {
                            server::stop(&mut srv.lock());
                        }
                        app.exit(0);
                    }
                    "show" => toggle_window(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // hide instead of quitting when the panel is closed
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(srv) = app_handle.try_state::<SharedServer>() {
                    server::stop(&mut srv.lock());
                }
            }
        });
}

fn toggle_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}
```

- [ ] **Step 3: Build**

Run: `cd /home/madalin/LlamaRanch/src-tauri && cargo build 2>&1 | tail -25`
Expected: compiles. Resolve any Tauri v2 API drift the compiler reports (method names like `get_webview_window`, `try_state` are v2-correct as of tauri 2.x).

- [ ] **Step 4: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "feat: app wiring, tray icon, window toggle, clean shutdown"
```

---

## Task 8: Frontend panel UI

**Files:**
- Modify: `index.html`, `src/main.ts`, `src/styles.css`

- [ ] **Step 1: Panel markup in `index.html`**

Replace `<body>...</body>` contents with:
```html
<body>
  <div id="app">
    <header>
      <h1>LlamaRanch</h1>
      <div id="serving" class="muted">idle</div>
    </header>
    <section class="endpoint">
      <code id="endpoint">http://127.0.0.1:2276/v1</code>
      <button id="copy">copy</button>
      <button id="webui">Open WebUI</button>
    </section>
    <div id="error" class="error hidden"></div>
    <section id="models"></section>
    <footer>
      <span id="version" class="muted"></span>
      <span class="spacer"></span>
      <button id="settings-btn">Settings</button>
      <button id="quit">Quit</button>
    </footer>
    <dialog id="settings">
      <form method="dialog">
        <label>Port <input id="s-port" type="number"></label>
        <label>Models dir <input id="s-models"></label>
        <label>Server bin <input id="s-bin"></label>
        <label><input id="s-expose" type="checkbox"> Expose to network</label>
        <menu>
          <button value="cancel">Cancel</button>
          <button id="s-save" value="save">Save</button>
        </menu>
      </form>
    </dialog>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
```

- [ ] **Step 2: Panel logic in `src/main.ts`**

Replace contents with:
```ts
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";

type ModelView = {
  id: string; name: string; group: string; path: string;
  size_bytes: number; mmproj_path: string | null; placement: string;
};
type StatusView = { status: string; model_id: string | null; endpoint: string };

const $ = (id: string) => document.getElementById(id)!;
const gb = (n: number) => (n / 1e9).toFixed(1) + " GB";

let pollTimer: number | undefined;

async function refresh() {
  const [models, status] = await Promise.all([
    invoke<ModelView[]>("list_models"),
    invoke<StatusView>("server_status"),
  ]);
  ($("endpoint") as HTMLElement).textContent = status.endpoint;
  ($("serving") as HTMLElement).textContent =
    status.status === "running" ? `serving: ${status.model_id}` : status.status;

  const err = $("error");
  if (status.status.startsWith("error")) {
    err.textContent = status.status;
    err.classList.remove("hidden");
  } else {
    err.classList.add("hidden");
  }

  const groups: Record<string, ModelView[]> = {};
  for (const m of models) (groups[m.group] ??= []).push(m);

  const host = $("models");
  host.innerHTML = "";
  for (const [group, list] of Object.entries(groups)) {
    const h = document.createElement("div");
    h.className = "group";
    h.textContent = group;
    host.appendChild(h);
    for (const m of list) {
      const row = document.createElement("div");
      row.className = "model";
      const running = status.model_id === m.id && status.status === "running";
      row.innerHTML = `
        <div class="info">
          <div class="name">${m.name}</div>
          <div class="meta muted">${gb(m.size_bytes)} - <span class="badge ${m.placement}">${m.placement}</span></div>
        </div>`;
      const btn = document.createElement("button");
      btn.textContent = running ? "Stop" : (status.model_id === m.id ? status.status : "Load");
      btn.disabled = status.status === "starting";
      btn.onclick = async () => {
        if (running) await invoke("stop_server");
        else await invoke("start_server", { modelId: m.id });
        await refresh();
        startPolling();
      };
      row.appendChild(btn);
      host.appendChild(row);
    }
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const s = await invoke<StatusView>("server_status");
    if (s.status !== "starting") {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    await refresh();
  }, 1500) as unknown as number;
}

async function init() {
  ($("version") as HTMLElement).textContent = await invoke<string>("llama_cpp_version");
  $("copy").onclick = async () => {
    await navigator.clipboard.writeText(($("endpoint") as HTMLElement).textContent || "");
  };
  $("webui").onclick = () => invoke("open_webui");
  $("quit").onclick = () => exit(0);

  const dlg = $("settings") as HTMLDialogElement;
  $("settings-btn").onclick = async () => {
    const cfg = await invoke<any>("get_config");
    ($("s-port") as HTMLInputElement).value = String(cfg.port);
    ($("s-models") as HTMLInputElement).value = cfg.models_dir;
    ($("s-bin") as HTMLInputElement).value = cfg.server_bin;
    ($("s-expose") as HTMLInputElement).checked = cfg.expose_to_network;
    dlg.showModal();
  };
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "save") return;
    await invoke("set_config", {
      newCfg: {
        port: Number(($("s-port") as HTMLInputElement).value),
        models_dir: ($("s-models") as HTMLInputElement).value,
        server_bin: ($("s-bin") as HTMLInputElement).value,
        expose_to_network: ($("s-expose") as HTMLInputElement).checked,
      },
    });
    await refresh();
  });

  await refresh();
}

init();
```

- [ ] **Step 3: Add the process plugin (for `exit`)**

Run:
```bash
cd /home/madalin/LlamaRanch && npm install @tauri-apps/plugin-process
cd src-tauri && cargo add tauri-plugin-process
```
Register it in `main.rs` builder chain (add before `.invoke_handler`): `.plugin(tauri_plugin_process::init())`
Add to `src-tauri/capabilities/default.json` permissions array: `"process:default"`.

- [ ] **Step 4: Styling in `src/styles.css`**

Replace contents with:
```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; }
#app { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
header { display: flex; align-items: baseline; justify-content: space-between; }
header h1 { font-size: 18px; margin: 0; }
.muted { color: #888; font-size: 12px; }
.endpoint { display: flex; align-items: center; gap: 8px; }
.endpoint code { background: rgba(127,127,127,.15); padding: 4px 6px; border-radius: 6px; font-size: 12px; flex: 1; }
button { border: 1px solid rgba(127,127,127,.4); background: transparent; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { background: rgba(127,127,127,.15); }
.group { text-transform: capitalize; font-size: 11px; letter-spacing: .05em; color: #888; margin: 8px 0 2px; }
.model { display: flex; align-items: center; justify-content: space-between; padding: 8px; border-radius: 8px; }
.model:hover { background: rgba(127,127,127,.08); }
.name { font-weight: 600; }
.badge { padding: 0 6px; border-radius: 4px; font-weight: 600; }
.badge.GPU { color: #2e7d32; } .badge.Partial { color: #ef6c00; } .badge.CPU { color: #6a6a6a; }
footer { display: flex; align-items: center; gap: 8px; border-top: 1px solid rgba(127,127,127,.2); padding-top: 10px; }
.spacer { flex: 1; }
.error { background: rgba(211,47,47,.12); color: #c62828; padding: 8px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; max-height: 120px; overflow: auto; }
.hidden { display: none; }
dialog label { display: block; margin: 8px 0; font-size: 13px; }
dialog input[type=text], dialog input[type=number], dialog input:not([type=checkbox]) { width: 100%; }
```

- [ ] **Step 5: Build to verify frontend + backend compile together**

Run: `cd /home/madalin/LlamaRanch && npm run tauri build -- --no-bundle 2>&1 | tail -25`
Expected: vite builds the frontend, cargo links the app, binary produced.

- [ ] **Step 6: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "feat: panel UI - model list, load/stop, endpoint, settings"
```

---

## Task 9: Icon + desktop launcher

**Files:**
- Create: `assets/llamaranch.svg`, `scripts/gen-icons.sh`, `scripts/llamaranch.desktop`, `scripts/install-desktop.sh`
- Modify: `src-tauri/tauri.conf.json` (icon paths), `src-tauri/icons/*`

- [ ] **Step 1: Save the provided SVG**

Write the llama SVG provided by the user to `assets/llamaranch.svg` verbatim.

- [ ] **Step 2: Generate PNG icon set**

Create `scripts/gen-icons.sh`:
```bash
#!/usr/bin/env bash
set -e
SVG=assets/llamaranch.svg
OUT=src-tauri/icons
mkdir -p "$OUT"
for s in 32 128 256 512; do
  rsvg-convert -w $s -h $s "$SVG" -o "$OUT/${s}x${s}.png"
done
cp "$OUT/512x512.png" "$OUT/icon.png"
cp "$OUT/128x128.png" "$OUT/128x128@2x.png" 2>/dev/null || true
```
Run:
```bash
cd /home/madalin/LlamaRanch && command -v rsvg-convert || sudo apt-get install -y librsvg2-bin
bash scripts/gen-icons.sh && ls src-tauri/icons
```
Expected: PNGs created. Point `tauri.conf.json` `bundle.icon` to `["icons/icon.png"]` and ensure `app.windows[0]` (and tray) use the generated icon.

- [ ] **Step 3: Desktop launcher**

Create `scripts/llamaranch.desktop`:
```ini
[Desktop Entry]
Type=Application
Name=LlamaRanch
Comment=Local LLM runner for llama.cpp
Exec=/home/madalin/LlamaRanch/src-tauri/target/release/llamaranch
Icon=llamaranch
Terminal=false
Categories=Utility;Development;
```
Create `scripts/install-desktop.sh`:
```bash
#!/usr/bin/env bash
set -e
install -Dm644 src-tauri/icons/256x256.png ~/.local/share/icons/hicolor/256x256/apps/llamaranch.png
install -Dm644 scripts/llamaranch.desktop ~/.local/share/applications/llamaranch.desktop
update-desktop-database ~/.local/share/applications 2>/dev/null || true
echo "Installed. Launch 'LlamaRanch' from your app launcher or run the binary directly."
```

- [ ] **Step 4: Commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "feat: app icon and desktop launcher"
```

---

## Task 10: End-to-end manual verification

No automated test - this is the human-in-the-loop acceptance step (real GPU + models required).

- [ ] **Step 1: Build release binary**

Run: `cd /home/madalin/LlamaRanch && npm run tauri build -- --no-bundle 2>&1 | tail -15`

- [ ] **Step 2: Launch the app**

Run: `/home/madalin/LlamaRanch/src-tauri/target/release/llamaranch &`
Expected: llama icon appears in the i3bar tray.

- [ ] **Step 3: Load a GPU model**

Click tray -> panel opens -> Load `Qwen3-4B`. Status goes `starting` -> `running`.
Verify: `curl -s http://127.0.0.1:2276/health` returns `{"status":"ok"}` (or 200).
Verify GPU use: `nvidia-smi` shows `llama-server` resident.

- [ ] **Step 4: Use it**

Click "Open WebUI" -> browser opens the chat UI -> send a message, get a reply.
Test the API:
```bash
curl -s http://127.0.0.1:2276/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}' | head -c 300
```

- [ ] **Step 5: Switch + stop + quit**

Load `Qwen3.6-35B-A3B` (expect slower start, CPU offload). Then Stop. Then Quit from the panel.
Verify no orphan: `pgrep -a llama-server` returns nothing.

- [ ] **Step 6: Install launcher (optional)**

Run: `cd /home/madalin/LlamaRanch && bash scripts/install-desktop.sh`

- [ ] **Step 7: Final commit**

```bash
cd /home/madalin/LlamaRanch && git add -A && git commit -m "docs: verified MVP end-to-end"
```

---

## Notes for the implementer

- **Tauri v2 API drift:** method/type names here target tauri 2.x. If a name moved, trust `cargo build` errors over this doc and adjust minimally.
- **Sync command blocking:** `start_server` returns immediately and spawns a polling thread; never block a command on `/health`.
- **Process cleanup is critical:** the child must die on Stop, on panel-driven Quit, and on `ExitRequested`. All three paths call `server::stop`.
- **Git commits:** this plan commits locally per task (no remote/GitHub). Confirm with the user before the first `git init` if they prefer no local git either.
