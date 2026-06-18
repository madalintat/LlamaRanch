use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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

/// `~/llama.cpp/build/bin/llama-server[.exe]`, resolved per-user and per-OS.
fn default_server_bin() -> String {
    let name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    home()
        .join("llama.cpp")
        .join("build")
        .join("bin")
        .join(name)
        .to_string_lossy()
        .into_owned()
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
