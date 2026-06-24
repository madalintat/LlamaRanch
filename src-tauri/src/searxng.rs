//! App-managed lifecycle for the local SearXNG container provisioned by the
//! wizard. Mirrors the router supervision in server.rs: start on launch, stop on
//! quit. Every operation here is best-effort and NON-fatal. Docker (or Podman)
//! may be absent or its daemon down, and the app must still launch and run fine,
//! so we never panic, never block the main thread, and only log on failure.
//!
//! Shared contract with the wizard (wizard/src/searxng.js), do not drift:
//!   setup dir   ~/.llamaranch/searxng/
//!   compose     docker-compose.yml (service searxng, container llamaranch-searxng)
//!   bind        127.0.0.1:8888 -> container 8080, restart: "no"
//!   config      searxng_url = "http://127.0.0.1:8888", searxng_managed = true

use crate::config::Config;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

/// `~/.llamaranch/searxng`, resolved the same way the rest of the code resolves home.
fn searxng_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".llamaranch")
        .join("searxng")
}

/// The compose file the wizard writes.
fn compose_file() -> PathBuf {
    searxng_dir().join("docker-compose.yml")
}

/// Prefer Docker, then Podman; None when neither responds. Cheap probe: ask each
/// runtime for its version and check the exit status (no daemon work required).
fn detect_runtime() -> Option<&'static str> {
    for rt in ["docker", "podman"] {
        let ok = Command::new(rt)
            .arg("version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some(rt);
        }
    }
    None
}

/// True when `url` points at the local loopback (the only place the app-managed
/// container is ever bound). Pure helper so it is unit-testable; gates start().
fn is_localhost_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    let rest = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
        .unwrap_or(&lower);
    // Strip the path first, then the port. Bracketed IPv6 (`[::1]:8888`) keeps
    // its colons inside the brackets, so handle that form explicitly.
    let authority = rest.split('/').next().unwrap_or("");
    let host = if let Some(rest) = authority.strip_prefix('[') {
        // `[::1]` or `[::1]:8888` -> `[::1]`
        rest.split(']').next().map(|h| format!("[{h}]")).unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
}

/// Start the managed container, best-effort, on a background thread so a slow or
/// absent Docker daemon can never stall app launch. No-op unless the config says
/// it is managed, the compose file exists, and the url is loopback.
pub fn start(cfg: &Config) {
    if !cfg.searxng_managed {
        return;
    }
    if !is_localhost_url(&cfg.searxng_url) {
        return;
    }
    let compose = compose_file();
    if !compose.exists() {
        return;
    }
    let dir = searxng_dir();
    std::thread::spawn(move || {
        let Some(rt) = detect_runtime() else {
            eprintln!("llamaranch: searxng start skipped, no container runtime (docker/podman) found");
            return;
        };
        // `<rt> compose -f <compose> up -d`, run from the setup dir because the
        // compose mounts a relative ./config volume.
        let status = Command::new(rt)
            .args(["compose", "-f", &compose.to_string_lossy(), "up", "-d"])
            .current_dir(&dir)
            .status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => eprintln!("llamaranch: searxng start exited with {s}"),
            Err(e) => eprintln!("llamaranch: searxng start failed to launch {rt}: {e}"),
        }
    });
}

/// Stop the managed container so it is not left running after the app quits.
/// Best-effort and quick, no-op when the compose file is absent.
pub fn stop() {
    let compose = compose_file();
    if !compose.exists() {
        return;
    }
    let Some(rt) = detect_runtime() else {
        return;
    };
    let status = Command::new(rt)
        .args(["compose", "-f", &compose.to_string_lossy(), "stop"])
        .current_dir(searxng_dir())
        .status();
    if let Err(e) = status {
        eprintln!("llamaranch: searxng stop failed to launch {rt}: {e}");
    }
}

/// GET `<url>/search?q=ok&format=json` with a ~2s timeout; true on 200. Optional
/// helper so a status command can report whether web search is actually up.
pub fn health(port_url: &str) -> bool {
    let base = port_url.trim_end_matches('/');
    let url = format!("{base}/search?q=ok&format=json");
    ureq::get(&url)
        .timeout(Duration::from_secs(2))
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localhost_urls_accepted() {
        assert!(is_localhost_url("http://127.0.0.1:8888"));
        assert!(is_localhost_url("http://localhost:8888"));
        assert!(is_localhost_url("http://127.0.0.1"));
        assert!(is_localhost_url("https://localhost/"));
        assert!(is_localhost_url("http://[::1]:8888"));
        assert!(is_localhost_url("  http://127.0.0.1:8888/  "));
    }

    #[test]
    fn non_localhost_urls_rejected() {
        assert!(!is_localhost_url("http://example.com:8888"));
        assert!(!is_localhost_url("http://192.168.1.10:8888"));
        assert!(!is_localhost_url("https://search.example.org"));
        assert!(!is_localhost_url(""));
        assert!(!is_localhost_url("http://localhost.evil.com"));
    }

    #[test]
    fn compose_path_matches_wizard_contract() {
        let p = compose_file();
        assert!(p.ends_with(".llamaranch/searxng/docker-compose.yml"));
    }

    #[test]
    fn health_false_when_nothing_listening() {
        // Port 1 is never a SearXNG; must not panic, must be false.
        assert!(!health("http://127.0.0.1:1"));
    }
}
