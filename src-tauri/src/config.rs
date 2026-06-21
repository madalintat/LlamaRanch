use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ModelOverride {
    #[serde(default)]
    pub ctx_size: Option<u32>,
    #[serde(default)]
    pub temp: Option<f32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    #[serde(default)]
    pub top_k: Option<u32>,
    #[serde(default)]
    pub min_p: Option<f32>,
    #[serde(default)]
    pub repeat_penalty: Option<f32>,
    #[serde(default)]
    pub presence_penalty: Option<f32>,
    #[serde(default)]
    pub frequency_penalty: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub port: u16,
    pub models_dir: String,
    pub server_bin: String,
    pub expose_to_network: bool,
    /// Unload an idle model after this many seconds (0 = never).
    #[serde(default)]
    pub sleep_idle_seconds: u32,
    /// Hugging Face access token, passed to the router for downloads (optional).
    #[serde(default)]
    pub hf_token: String,
    /// Max models the router keeps loaded at once (hardware-aware default).
    #[serde(default = "default_models_max")]
    pub models_max: u32,
    /// Per-model configuration overrides.
    #[serde(default)]
    pub model_config: BTreeMap<String, ModelOverride>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `~/llama.cpp/models`, resolved per-user and per-OS.
fn default_models_dir() -> String {
    home()
        .join("llama.cpp")
        .join("models")
        .to_string_lossy()
        .into_owned()
}

/// First candidate that satisfies `exists`, if any. Order = priority.
fn first_existing(candidates: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|p| exists(p.as_path())).cloned()
}

/// Keep `current` if it exists; otherwise the first existing candidate;
/// otherwise `current` unchanged (preserves the existing not-found UX).
fn reconcile(current: &Path, candidates: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    if exists(current) {
        return current.to_path_buf();
    }
    first_existing(candidates, exists).unwrap_or_else(|| current.to_path_buf())
}

fn server_bin_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// The historical default: `~/llama.cpp/build/bin/llama-server[.exe]`.
fn source_build_bin() -> PathBuf {
    home()
        .join("llama.cpp")
        .join("build")
        .join("bin")
        .join(server_bin_name())
}

/// Scan `PATH` for `llama-server[.exe]` (last resort; only useful when the
/// process actually has a populated PATH, e.g. terminal-launched dev runs).
fn which_server() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(server_bin_name()))
        .find(|p| p.is_file())
}

/// Ordered `llama-server` locations; first existing wins. Additive across
/// platforms: brew paths are macOS/Unix; `source_build_bin()` keeps Linux,
/// Windows and source builds resolving exactly as before.
fn server_bin_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = std::env::var_os("LLAMARANCH_SERVER_BIN") {
        if !p.is_empty() {
            v.push(PathBuf::from(p));
        }
    }
    v.push(PathBuf::from("/opt/homebrew/bin/llama-server")); // Apple Silicon brew
    v.push(PathBuf::from("/usr/local/bin/llama-server")); // Intel brew
    v.push(source_build_bin());
    if let Some(p) = which_server() {
        v.push(p);
    }
    v
}

/// Resolve `llama-server` for a fresh config: first existing candidate, else
/// the historical default (so the existing "not found" error/UX is preserved).
pub fn discover_server_bin() -> String {
    first_existing(&server_bin_candidates(), &|p| p.is_file())
        .unwrap_or_else(source_build_bin)
        .to_string_lossy()
        .into_owned()
}

/// Given a possibly-stale stored path, keep it if it still exists, otherwise
/// re-discover. Never overrides a path that exists (respects user's choice).
pub fn ensure_server_bin(current: &str) -> String {
    reconcile(Path::new(current), &server_bin_candidates(), &|p| p.is_file())
        .to_string_lossy()
        .into_owned()
}

fn default_server_bin() -> String {
    discover_server_bin()
}

/// Total physical RAM in bytes, per-OS, std only. None if detection fails.
fn total_ram_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
    #[cfg(target_os = "linux")]
    {
        let txt = std::fs::read_to_string("/proc/meminfo").ok()?;
        for line in txt.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
                return Some(kb * 1024);
            }
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

/// How many models to keep resident by default, from total RAM:
/// clamp(GB / 10, 1, 4). The router's `--fit` still sizes each load to memory.
fn models_max_for_ram(bytes: u64) -> u32 {
    let gb = bytes / 1_000_000_000;
    (gb / 10).clamp(1, 4) as u32
}

/// Hardware-aware default; falls back to 2 when RAM can't be detected.
fn default_models_max() -> u32 {
    total_ram_bytes().map(models_max_for_ram).unwrap_or(2)
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: 2276,
            models_dir: default_models_dir(),
            server_bin: default_server_bin(),
            expose_to_network: false,
            sleep_idle_seconds: 0,
            hf_token: String::new(),
            models_max: default_models_max(),
            model_config: BTreeMap::new(),
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

    #[test]
    fn first_existing_returns_earliest_present() {
        let cands = vec![
            PathBuf::from("/a/llama-server"),
            PathBuf::from("/b/llama-server"),
            PathBuf::from("/c/llama-server"),
        ];
        let present = |p: &Path| {
            p == Path::new("/b/llama-server") || p == Path::new("/c/llama-server")
        };
        assert_eq!(
            first_existing(&cands, &present),
            Some(PathBuf::from("/b/llama-server"))
        );
    }

    #[test]
    fn first_existing_none_when_absent() {
        let cands = vec![PathBuf::from("/a/llama-server")];
        assert_eq!(first_existing(&cands, &|_| false), None);
    }

    #[test]
    fn reconcile_keeps_current_when_present() {
        let current = PathBuf::from("/usr/bin/llama-server");
        let cands = vec![PathBuf::from("/opt/homebrew/bin/llama-server")];
        let present = |p: &Path| {
            p == Path::new("/usr/bin/llama-server")
                || p == Path::new("/opt/homebrew/bin/llama-server")
        };
        assert_eq!(reconcile(&current, &cands, &present), current);
    }

    #[test]
    fn reconcile_picks_candidate_when_current_missing() {
        let current = PathBuf::from("/old/llama-server");
        let cands = vec![PathBuf::from("/opt/homebrew/bin/llama-server")];
        let present = |p: &Path| p == Path::new("/opt/homebrew/bin/llama-server");
        assert_eq!(
            reconcile(&current, &cands, &present),
            PathBuf::from("/opt/homebrew/bin/llama-server")
        );
    }

    #[test]
    fn reconcile_keeps_current_when_nothing_present() {
        let current = PathBuf::from("/old/llama-server");
        let cands = vec![PathBuf::from("/opt/homebrew/bin/llama-server")];
        assert_eq!(reconcile(&current, &cands, &|_| false), current);
    }

    #[test]
    fn models_max_scales_with_ram() {
        assert_eq!(models_max_for_ram(8_000_000_000), 1);
        assert_eq!(models_max_for_ram(24_000_000_000), 2);
        assert_eq!(models_max_for_ram(32_000_000_000), 3);
        assert_eq!(models_max_for_ram(40_000_000_000), 4);
        assert_eq!(models_max_for_ram(128_000_000_000), 4);
    }

    #[test]
    fn models_max_floor_is_one() {
        assert_eq!(models_max_for_ram(2_000_000_000), 1);
        assert_eq!(models_max_for_ram(0), 1);
    }

    #[test]
    fn missing_models_max_uses_default() {
        let json = r#"{"port":2276,"models_dir":"/m","server_bin":"/b","expose_to_network":false}"#;
        let cfg: Config = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.models_max, default_models_max());
    }

    #[test]
    fn model_config_roundtrips() {
        let mut cfg = Config::default();
        cfg.model_config.insert(
            "Qwen3".into(),
            ModelOverride { ctx_size: Some(8192), temp: Some(0.7), ..Default::default() },
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        save_to(&p, &cfg).unwrap();
        assert_eq!(load_from(&p), cfg);
    }

    #[test]
    fn missing_model_config_is_empty() {
        let json = r#"{"port":2276,"models_dir":"/m","server_bin":"/b","expose_to_network":false}"#;
        let cfg: Config = serde_json::from_str(json).unwrap();
        assert!(cfg.model_config.is_empty());
    }
}
