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
        assert!(!health_ok(1));
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
        thread::sleep(Duration::from_millis(200));
        let alive = Command::new("kill").args(["-0", &pid.to_string()]).status().unwrap().success();
        assert!(!alive);
    }
}
