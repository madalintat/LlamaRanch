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
use std::time::{Duration, Instant};

/// The container name the wizard uses; keep both sides in lockstep.
const CONTAINER_NAME: &str = "llamaranch-searxng";

/// `~/.llamaranch/searxng`, resolved the same way the rest of the code resolves home.
fn searxng_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".llamaranch")
        .join("searxng")
}

/// `~/.llamaranch/searxng/config`, where settings.yml lives (mounted at /etc/searxng).
fn config_dir() -> PathBuf {
    searxng_dir().join("config")
}

/// The settings file the wizard writes.
fn settings_file() -> PathBuf {
    config_dir().join("settings.yml")
}

/// The compose file the wizard writes.
fn compose_file() -> PathBuf {
    searxng_dir().join("docker-compose.yml")
}

/// Prefer Docker, then Podman; None when neither's daemon responds. `<rt> version`
/// talks to the SERVER, so it only succeeds when the daemon is reachable. This is
/// the right gate for start()/stop() (which need a live daemon), but NOT for
/// telling "installed" from "running" (use cli_present + daemon_up for that).
fn detect_runtime() -> Option<&'static str> {
    for rt in ["docker", "podman"] {
        if daemon_up(rt) {
            return Some(rt);
        }
    }
    None
}

/// The first installed container CLI (Docker, then Podman), regardless of whether
/// its daemon is up. `<rt> --version` only touches the CLI binary, so it succeeds
/// even when Docker Desktop / OrbStack / the Podman machine is stopped. Lets the
/// UI tell "installed but stopped" apart from "not installed at all".
pub fn cli_present() -> Option<&'static str> {
    ["docker", "podman"].into_iter().find(|rt| which(rt))
}

/// True when `rt`'s daemon is reachable. `<rt> info` (and `<rt> version`) round-trip
/// to the server, so a non-zero exit means the CLI is installed but the daemon is
/// down. Cheap, best-effort, never panics.
pub fn daemon_up(rt: &str) -> bool {
    Command::new(rt)
        .arg("info")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Best-effort start of an installed-but-stopped container runtime. Prefers
/// OrbStack (`orb start`), then Docker Desktop on macOS (`open -a Docker`), then a
/// Podman machine (`podman machine start`). Returns quickly: it only kicks off the
/// start, callers poll `daemon_up` for readiness. Non-fatal, never panics; returns
/// Err with a short hint when nothing can be launched.
pub fn start_runtime() -> Result<(), String> {
    // OrbStack: the `orb` CLI brings up the whole runtime (Docker + machines).
    if which("orb") {
        return Command::new("orb")
            .arg("start")
            .status()
            .map(|_| ())
            .map_err(|e| format!("could not run orb start: {e}"));
    }
    // Docker Desktop on macOS: open the app, which starts the daemon.
    #[cfg(target_os = "macos")]
    if which("docker") {
        return Command::new("open")
            .args(["-a", "Docker"])
            .status()
            .map(|_| ())
            .map_err(|e| format!("could not launch Docker Desktop: {e}"));
    }
    // Podman: bring up its VM.
    if which("podman") {
        return Command::new("podman")
            .args(["machine", "start"])
            .status()
            .map(|_| ())
            .map_err(|e| format!("could not run podman machine start: {e}"));
    }
    Err("open Docker, OrbStack, or Podman manually, then try again".into())
}

/// True when `name` resolves on PATH. Cheap probe via `<name> --version` so it works
/// for both real binaries and shim CLIs without spawning a shell.
fn which(name: &str) -> bool {
    Command::new(name)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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

/// Public probe for a container runtime, Docker then Podman, None when neither
/// responds. Lets the commands layer decide between a "Set up" button and an
/// "install a runtime" card without reaching into the private detector.
pub fn runtime() -> Option<&'static str> {
    detect_runtime()
}

/// The exact settings.yml the wizard writes (wizard/src/searxng.js, settingsYaml).
/// `secret_key` is a per-install random hex string. Keep this byte-for-byte in
/// sync with the wizard so a re-run from either side never drifts the config.
fn settings_yml(secret_key: &str) -> String {
    [
        "use_default_settings: true",
        "server:",
        &format!("  secret_key: \"{secret_key}\""),
        "  limiter: false",
        "  image_proxy: false",
        "search:",
        "  formats:",
        "    - html",
        "    - json",
        "",
    ]
    .join("\n")
}

/// The exact docker-compose.yml the wizard writes (wizard/src/searxng.js,
/// composeYaml). Container name, loopback bind, and `restart: "no"` are the
/// load-bearing parts of the shared contract; the app owns start/stop.
fn compose_yml() -> String {
    [
        "services:",
        "  searxng:",
        "    image: searxng/searxng:latest",
        &format!("    container_name: {CONTAINER_NAME}"),
        "    ports:",
        "      - \"127.0.0.1:8888:8080\"",
        "    volumes:",
        "      - ./config:/etc/searxng:rw",
        "    environment:",
        "      - SEARXNG_BASE_URL=http://localhost:8888/",
        "    restart: \"no\"",
        "",
    ]
    .join("\n")
}

/// A 64-char random hex secret_key drawn from the OS CSPRNG, matching the wizard
/// (which uses Node's crypto.randomBytes(32)). This is a SearXNG session secret on
/// a loopback-only instance; a real CSPRNG keeps it unguessable to a local observer
/// rather than derivable from the clock + pid + path. `getrandom::fill` reads from
/// the platform RNG (getrandom/urandom on unix, BCryptGenRandom on Windows) and is
/// already compiled into the dependency tree.
fn random_hex_key() -> String {
    let mut bytes = [0u8; 32];
    // The OS RNG only fails in pathological setups (no entropy source); fall back
    // to a fixed buffer so we still produce a 64-hex key rather than panicking.
    if getrandom::fill(&mut bytes).is_err() {
        bytes = [0x5au8; 32];
    }
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Provision the on-disk files the app-managed container needs, matching the
/// wizard exactly. Creates `~/.llamaranch/searxng/config/`, writes settings.yml
/// only when absent (so a user's hand-edits and the stable secret_key survive a
/// re-run), and always (re)writes docker-compose.yml so the contract stays fresh.
pub fn write_files() -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir())?;
    let settings = settings_file();
    if !settings.exists() {
        std::fs::write(&settings, settings_yml(&random_hex_key()))?;
    }
    std::fs::write(compose_file(), compose_yml())?;
    Ok(())
}

/// Pull the SearXNG image with the given runtime, running compose from the setup
/// dir. Falls back to a plain `<rt> pull` when an older compose plugin lacks the
/// `pull` subcommand (mirrors the wizard's fallback). Blocking; call off the UI thread.
pub fn pull(rt: &str) -> Result<(), String> {
    let compose = compose_file();
    let dir = searxng_dir();
    let via_compose = Command::new(rt)
        .args(["compose", "-f", &compose.to_string_lossy(), "pull"])
        .current_dir(&dir)
        .status();
    if let Ok(s) = via_compose {
        if s.success() {
            return Ok(());
        }
    }
    // Fallback: pull the image directly.
    let status = Command::new(rt)
        .args(["pull", "searxng/searxng:latest"])
        .status()
        .map_err(|e| format!("could not run {rt} pull: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("image pull exited with {status}"))
    }
}

/// `<rt> compose -f <file> up -d`, run from the setup dir (the compose mounts a
/// relative ./config volume). Blocking; call off the UI thread.
pub fn up(rt: &str) -> Result<(), String> {
    let compose = compose_file();
    let status = Command::new(rt)
        .args(["compose", "-f", &compose.to_string_lossy(), "up", "-d"])
        .current_dir(searxng_dir())
        .status()
        .map_err(|e| format!("could not run {rt} compose up: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("compose up exited with {status}"))
    }
}

/// Poll `health(url)` until it answers a JSON search or `timeout_secs` elapses.
/// Returns true once SearXNG is up, false on timeout. Blocking; call off the UI thread.
pub fn wait_healthy(url: &str, timeout_secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if health(url) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// `<rt> compose -f <file> down`, removing the managed container. Best-effort,
/// run from the setup dir. Blocking; call off the UI thread.
pub fn down(rt: &str) -> Result<(), String> {
    let compose = compose_file();
    let status = Command::new(rt)
        .args(["compose", "-f", &compose.to_string_lossy(), "down"])
        .current_dir(searxng_dir())
        .status()
        .map_err(|e| format!("could not run {rt} compose down: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("compose down exited with {status}"))
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

    #[test]
    fn compose_matches_wizard_contract() {
        let c = compose_yml();
        assert!(c.contains("llamaranch-searxng"), "container name drifted");
        assert!(c.contains("127.0.0.1:8888:8080"), "loopback bind drifted");
        assert!(c.contains("restart: \"no\""), "restart policy drifted");
        assert!(c.contains("image: searxng/searxng:latest"));
        assert!(c.contains("./config:/etc/searxng:rw"));
    }

    #[test]
    fn settings_matches_wizard_contract() {
        let s = settings_yml("deadbeef");
        assert!(s.contains("use_default_settings: true"));
        assert!(s.contains("secret_key: \"deadbeef\""));
        assert!(s.contains("limiter: false"), "limiter must be off");
        assert!(s.contains("image_proxy: false"));
        assert!(s.contains("formats"), "search.formats missing");
        assert!(s.contains("- json"), "json format is the 403 fix, required");
        assert!(s.contains("- html"));
    }

    #[test]
    fn random_hex_key_is_long_and_hex() {
        let k = random_hex_key();
        assert!(k.len() >= 32, "key must be at least 32 hex chars, got {}", k.len());
        assert!(k.chars().all(|c| c.is_ascii_hexdigit()), "key must be hex: {k}");
        // Two calls should differ (PRNG advances on time/state).
        assert_ne!(random_hex_key(), random_hex_key());
    }
}
