//! Tool registry + safe tools (get_time, calculate, read_file, web_fetch, web_search).
//! Phase 2b: real I/O tools with SSRF-safe sandboxing, path allowlist, audit log.
use serde_json::{json, Value};

pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> Value; // JSON Schema
    fn run(&self, args: &Value) -> Result<String, String>;
}

// ── SSRF guard ────────────────────────────────────────────────────────────────

/// Returns true for hosts that must never be fetched (SSRF-unsafe).
/// Accepts either a bare hostname/IP or a `host:port` string.
pub fn is_blocked_host(host: &str) -> bool {
    if host.is_empty() {
        return true;
    }
    // Strip port suffix (handle IPv6 brackets too).
    let bare = strip_port(host);
    if bare.is_empty() {
        return true;
    }

    // Exact / keyword matches.
    let lo = bare.to_ascii_lowercase();
    if matches!(lo.as_str(), "localhost" | "0.0.0.0" | "::1") {
        return true;
    }
    // IPv6 link-local / ULA.
    if lo.starts_with("fe80:") || lo.starts_with("fc") || lo.starts_with("fd") {
        return true;
    }

    // Parse as IPv4.
    if let Ok(addr) = lo.parse::<std::net::Ipv4Addr>() {
        let octets = addr.octets();
        return matches!(octets,
            [127, ..] |       // 127.0.0.0/8
            [10, ..] |        // 10.0.0.0/8
            [169, 254, ..] |  // 169.254.0.0/16 link-local
            [0, 0, 0, 0]      // 0.0.0.0
        ) || (octets[0] == 192 && octets[1] == 168)      // 192.168.0.0/16
          || (octets[0] == 172 && (16..=31).contains(&octets[1])); // 172.16-31.x
    }

    false
}

/// Strip port from `host:port` or `[ipv6]:port`.
fn strip_port(host: &str) -> &str {
    // IPv6 with brackets: `[::1]:8080` → `::1`
    if host.starts_with('[') {
        return host.trim_start_matches('[').splitn(2, ']').next().unwrap_or("");
    }
    // IPv4 or hostname with port: `127.0.0.1:8080` → `127.0.0.1`
    // But a plain IPv6 like `::1` also contains colons; count them.
    let colon_count = host.chars().filter(|&c| c == ':').count();
    if colon_count == 1 {
        // Exactly one colon → `host:port`
        return host.splitn(2, ':').next().unwrap_or(host);
    }
    host
}

// ── Path allowlist ────────────────────────────────────────────────────────────

/// Returns true only if `path` (canonicalized, no `..` escapes) lives inside
/// one of `roots`. Empty roots → always false.
pub fn path_allowed(path: &str, roots: &[String]) -> bool {
    if roots.is_empty() {
        return false;
    }
    // Reject any component that is `..`
    let p = std::path::Path::new(path);
    for comp in p.components() {
        if comp == std::path::Component::ParentDir {
            return false;
        }
    }
    // Must be under at least one root (prefix match on the normalised string).
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        return false; // relative paths without an absolute root are rejected
    };
    let abs_str = abs.to_string_lossy();
    roots.iter().any(|root| {
        let root_path = std::path::Path::new(root);
        // Use starts_with on Path components (not raw string prefix) to avoid
        // partial-component matches like `/foo` matching `/foobar`.
        abs.starts_with(root_path)
            && abs_str.len() >= root.len() // sanity
    })
}

// ── Audit helper ──────────────────────────────────────────────────────────────

fn audit(name: &str, ok: bool) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("{{\"ts\":{ts},\"name\":{:?},\"ok\":{ok}}}\n", name);
    if let Some(dir) = dirs::config_dir() {
        let log_dir = dir.join("llamaranch");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("tool-audit.jsonl");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

// ── Registry ──────────────────────────────────────────────────────────────────

pub struct ToolRegistry {
    tools: Vec<Box<dyn Tool>>,
}

impl ToolRegistry {
    /// Minimal registry used by existing tests (no I/O tools).
    #[cfg(test)]
    pub fn with_defaults() -> Self {
        ToolRegistry { tools: vec![Box::new(Clock), Box::new(Calculator)] }
    }

    /// Full registry built from app config.
    pub fn with_config(cfg: &crate::config::Config) -> Self {
        let mut tools: Vec<Box<dyn Tool>> = vec![
            Box::new(Clock),
            Box::new(Calculator),
            Box::new(ReadFile { roots: cfg.allowed_dirs.clone() }),
        ];
        if !cfg.offline_mode {
            tools.push(Box::new(WebFetch));
            tools.push(Box::new(WebSearch { endpoint: cfg.searxng_url.clone() }));
        }
        ToolRegistry { tools }
    }

    /// OpenAI `tools` array for the request.
    pub fn openai_tools(&self) -> Value {
        Value::Array(
            self.tools
                .iter()
                .map(|t| json!({
                    "type": "function",
                    "function": { "name": t.name(), "description": t.description(), "parameters": t.parameters() }
                }))
                .collect(),
        )
    }

    /// Dispatch by name; parse `args_json` (a JSON string); return Ok(result) or Err(message).
    pub fn run(&self, name: &str, args_json: &str) -> Result<String, String> {
        let args: Value = serde_json::from_str(args_json).unwrap_or(Value::Null);
        let result = match self.tools.iter().find(|t| t.name() == name) {
            Some(t) => t.run(&args),
            None => Err(format!("unknown tool '{name}'")),
        };
        audit(name, result.is_ok());
        result
    }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

struct Clock;
impl Tool for Clock {
    fn name(&self) -> &str { "get_time" }
    fn description(&self) -> &str { "Get the current time as seconds since the Unix epoch (UTC)." }
    fn parameters(&self) -> Value { json!({ "type": "object", "properties": {} }) }
    fn run(&self, _args: &Value) -> Result<String, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?;
        Ok(format!("unix_seconds={} (UTC)", now.as_secs()))
    }
}

struct Calculator;
impl Tool for Calculator {
    fn name(&self) -> &str { "calculate" }
    fn description(&self) -> &str { "Evaluate an arithmetic expression (+ - * /, parentheses). Returns the number." }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "expression": { "type": "string", "description": "e.g. (2+3)*4" } },
            "required": ["expression"]
        })
    }
    fn run(&self, args: &Value) -> Result<String, String> {
        let expr = args.get("expression").and_then(|v| v.as_str()).ok_or("missing 'expression'")?;
        eval_expr(expr).map(|n| {
            if n.fract() == 0.0 { format!("{:.0}", n) } else { format!("{n}") }
        })
    }
}

/// Read a local file; requires path to be inside one of the configured `roots`.
struct ReadFile { roots: Vec<String> }
impl Tool for ReadFile {
    fn name(&self) -> &str { "read_file" }
    fn description(&self) -> &str {
        "Read a local file. The path must be inside a folder that has been granted in Settings."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "Absolute path to the file." } },
            "required": ["path"]
        })
    }
    fn run(&self, args: &Value) -> Result<String, String> {
        let path = args.get("path").and_then(|v| v.as_str())
            .ok_or("missing 'path'")?;
        if !path_allowed(path, &self.roots) {
            return Err("access to that path is not allowed — grant the folder in Settings".into());
        }
        const CAP: usize = 64 * 1024;
        let content = std::fs::read(path).map_err(|e| e.to_string())?;
        if content.len() > CAP {
            // Attempt UTF-8; fall back to lossy. Truncate at CAP bytes.
            let text = String::from_utf8_lossy(&content[..CAP]).into_owned();
            Ok(format!("{text}\n[…truncated at 64 KB]"))
        } else {
            String::from_utf8(content).map_err(|e| e.to_string())
        }
    }
}

/// Fetch a URL; SSRF-blocked for private/link-local addresses.
struct WebFetch;
impl Tool for WebFetch {
    fn name(&self) -> &str { "web_fetch" }
    fn description(&self) -> &str {
        "Fetch the content of a public HTTP/HTTPS URL. Private/internal addresses are blocked."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "url": { "type": "string", "description": "A public https:// or http:// URL." } },
            "required": ["url"]
        })
    }
    fn run(&self, args: &Value) -> Result<String, String> {
        let url_str = args.get("url").and_then(|v| v.as_str())
            .ok_or("missing 'url'")?;
        let url = url_str.parse::<url::Url>()
            .map_err(|e| format!("blocked or invalid URL: {e}"))?;
        let scheme = url.scheme();
        if scheme != "http" && scheme != "https" {
            return Err("blocked or invalid URL".into());
        }
        let host = url.host_str().unwrap_or("");
        // Include port in the check so `localhost:8080` is blocked.
        let host_with_port = match url.port() {
            Some(p) => format!("{host}:{p}"),
            None => host.to_string(),
        };
        if is_blocked_host(&host_with_port) {
            return Err("blocked or invalid URL".into());
        }
        const CAP: usize = 128 * 1024;
        let resp = ureq::get(url_str)
            .timeout(std::time::Duration::from_secs(20))
            .call()
            .map_err(|e| e.to_string())?;
        let mut body = String::new();
        use std::io::Read;
        resp.into_reader()
            .take(CAP as u64)
            .read_to_string(&mut body)
            .map_err(|e| e.to_string())?;
        if body.len() == CAP {
            body.push_str("\n[…truncated at 128 KB]");
        }
        Ok(body)
    }
}

/// Search via a self-hosted SearXNG instance.
struct WebSearch { endpoint: String }
impl Tool for WebSearch {
    fn name(&self) -> &str { "web_search" }
    fn description(&self) -> &str {
        "Search the web via a configured SearXNG instance. Returns top results as title — url\\nsnippet."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "query": { "type": "string", "description": "Search query." } },
            "required": ["query"]
        })
    }
    fn run(&self, args: &Value) -> Result<String, String> {
        if self.endpoint.is_empty() {
            return Err("web search not configured — set a SearXNG URL in Settings".into());
        }
        let query = args.get("query").and_then(|v| v.as_str())
            .ok_or("missing 'query'")?;
        let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
        let search_url = format!("{}/search?q={}&format=json", self.endpoint.trim_end_matches('/'), encoded);
        let resp = ureq::get(&search_url)
            .timeout(std::time::Duration::from_secs(20))
            .call()
            .map_err(|e| e.to_string())?;
        let data: Value = resp.into_json().map_err(|e| e.to_string())?;
        let results = data.get("results").and_then(|v| v.as_array())
            .ok_or("unexpected SearXNG response format")?;
        let lines: Vec<String> = results.iter().take(5).map(|r| {
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("(no title)");
            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let snippet = r.get("content").and_then(|v| v.as_str()).unwrap_or("");
            format!("{title} — {url}\n{snippet}")
        }).collect();
        if lines.is_empty() {
            Ok("No results found.".into())
        } else {
            Ok(lines.join("\n\n"))
        }
    }
}

// ── Pure arithmetic evaluator (unchanged from Phase 2a) ───────────────────────

/// Pure recursive-descent evaluator: + - * /, parentheses, unary minus, decimals.
pub fn eval_expr(input: &str) -> Result<f64, String> {
    let tokens = tokenize(input)?;
    let mut p = Parser { tokens, pos: 0 };
    let v = p.expr()?;
    if p.pos != p.tokens.len() {
        return Err("unexpected trailing input".into());
    }
    Ok(v)
}

#[derive(Clone, Debug, PartialEq)]
enum Tok { Num(f64), Plus, Minus, Star, Slash, LParen, RParen }

fn tokenize(s: &str) -> Result<Vec<Tok>, String> {
    let mut out = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' => { i += 1; }
            '+' => { out.push(Tok::Plus); i += 1; }
            '-' => { out.push(Tok::Minus); i += 1; }
            '*' => { out.push(Tok::Star); i += 1; }
            '/' => { out.push(Tok::Slash); i += 1; }
            '(' => { out.push(Tok::LParen); i += 1; }
            ')' => { out.push(Tok::RParen); i += 1; }
            c if c.is_ascii_digit() || c == '.' => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') { i += 1; }
                let num: String = chars[start..i].iter().collect();
                out.push(Tok::Num(num.parse().map_err(|_| format!("bad number '{num}'"))?));
            }
            other => return Err(format!("unexpected character '{other}'")),
        }
    }
    Ok(out)
}

struct Parser { tokens: Vec<Tok>, pos: usize }
impl Parser {
    fn peek(&self) -> Option<&Tok> { self.tokens.get(self.pos) }
    fn expr(&mut self) -> Result<f64, String> {
        let mut v = self.term()?;
        while let Some(t) = self.peek() {
            match t {
                Tok::Plus => { self.pos += 1; v += self.term()?; }
                Tok::Minus => { self.pos += 1; v -= self.term()?; }
                _ => break,
            }
        }
        Ok(v)
    }
    fn term(&mut self) -> Result<f64, String> {
        let mut v = self.factor()?;
        while let Some(t) = self.peek() {
            match t {
                Tok::Star => { self.pos += 1; v *= self.factor()?; }
                Tok::Slash => {
                    self.pos += 1;
                    let d = self.factor()?;
                    if d == 0.0 { return Err("division by zero".into()); }
                    v /= d;
                }
                _ => break,
            }
        }
        Ok(v)
    }
    fn factor(&mut self) -> Result<f64, String> {
        match self.peek().cloned() {
            Some(Tok::Num(n)) => { self.pos += 1; Ok(n) }
            Some(Tok::Minus) => { self.pos += 1; Ok(-self.factor()?) }
            Some(Tok::LParen) => {
                self.pos += 1;
                let v = self.expr()?;
                match self.peek() {
                    Some(Tok::RParen) => { self.pos += 1; Ok(v) }
                    _ => Err("expected ')'".into()),
                }
            }
            _ => Err("expected a number".into()),
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_blocked_host ───────────────────────────────────────────────────────

    #[test]
    fn blocked_localhost() {
        assert!(is_blocked_host("localhost"));
        assert!(is_blocked_host("localhost:8080"));
    }

    #[test]
    fn blocked_127_range() {
        assert!(is_blocked_host("127.0.0.1"));
        assert!(is_blocked_host("127.255.255.255"));
        assert!(is_blocked_host("127.0.0.1:9200"));
    }

    #[test]
    fn blocked_private_ranges() {
        assert!(is_blocked_host("10.0.0.1"));
        assert!(is_blocked_host("10.255.255.255"));
        assert!(is_blocked_host("192.168.1.100"));
        assert!(is_blocked_host("172.16.0.1"));
        assert!(is_blocked_host("172.31.255.255"));
    }

    #[test]
    fn blocked_link_local() {
        assert!(is_blocked_host("169.254.1.1"));
        assert!(is_blocked_host("0.0.0.0"));
        assert!(is_blocked_host("::1"));
        assert!(is_blocked_host("fe80::1"));
    }

    #[test]
    fn blocked_empty() {
        assert!(is_blocked_host(""));
    }

    #[test]
    fn allowed_public_hosts() {
        assert!(!is_blocked_host("example.com"));
        assert!(!is_blocked_host("1.2.3.4"));
        assert!(!is_blocked_host("8.8.8.8"));
        assert!(!is_blocked_host("api.openai.com"));
        assert!(!is_blocked_host("172.15.0.1")); // just outside 172.16-31 range
        assert!(!is_blocked_host("172.32.0.1")); // just outside 172.16-31 range
        assert!(!is_blocked_host("11.0.0.1"));   // not 10.x
        assert!(!is_blocked_host("192.169.1.1")); // not 192.168.x
    }

    // ── path_allowed ──────────────────────────────────────────────────────────

    #[test]
    fn path_under_root_ok() {
        let roots = vec!["/home/user/docs".to_string()];
        assert!(path_allowed("/home/user/docs/file.txt", &roots));
        assert!(path_allowed("/home/user/docs/subdir/a.txt", &roots));
    }

    #[test]
    fn path_outside_root_blocked() {
        let roots = vec!["/home/user/docs".to_string()];
        assert!(!path_allowed("/etc/passwd", &roots));
        assert!(!path_allowed("/home/user/other/file.txt", &roots));
    }

    #[test]
    fn path_traversal_blocked() {
        let roots = vec!["/home/user/docs".to_string()];
        assert!(!path_allowed("/home/user/docs/../etc/passwd", &roots));
        assert!(!path_allowed("../etc/passwd", &roots));
    }

    #[test]
    fn path_empty_roots_always_false() {
        assert!(!path_allowed("/home/user/docs/file.txt", &[]));
    }

    #[test]
    fn path_no_partial_component_match() {
        let roots = vec!["/home/user/docs".to_string()];
        // `/home/user/docsextra` must NOT match `/home/user/docs`
        assert!(!path_allowed("/home/user/docsextra/file.txt", &roots));
    }

    // ── registry + tools ──────────────────────────────────────────────────────

    #[test]
    fn calc_precedence_and_parens() {
        assert_eq!(eval_expr("2+3*4").unwrap(), 14.0);
        assert_eq!(eval_expr("(2+3)*4").unwrap(), 20.0);
        assert_eq!(eval_expr("-3 + 5").unwrap(), 2.0);
        assert_eq!(eval_expr("10 / 4").unwrap(), 2.5);
    }

    #[test]
    fn calc_errors() {
        assert!(eval_expr("1/0").is_err());
        assert!(eval_expr("2+").is_err());
        assert!(eval_expr("abc").is_err());
        assert!(eval_expr("2 2").is_err());
    }

    #[test]
    fn registry_exposes_and_dispatches() {
        let r = ToolRegistry::with_defaults();
        let tools = r.openai_tools();
        let names: Vec<&str> = tools.as_array().unwrap().iter()
            .map(|t| t["function"]["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"get_time") && names.contains(&"calculate"));
        assert_eq!(r.run("calculate", r#"{"expression":"6*7"}"#).unwrap(), "42");
        assert!(r.run("calculate", r#"{"expression":"1/0"}"#).is_err());
        assert!(r.run("nope", "{}").is_err());
    }

    #[test]
    fn read_file_blocked_when_no_roots() {
        let tool = ReadFile { roots: vec![] };
        let args = json!({ "path": "/etc/passwd" });
        assert!(tool.run(&args).is_err());
    }

    #[test]
    fn read_file_blocked_outside_root() {
        let tool = ReadFile { roots: vec!["/home/user/docs".into()] };
        let args = json!({ "path": "/etc/passwd" });
        let err = tool.run(&args).unwrap_err();
        assert!(err.contains("not allowed"));
    }

    #[test]
    fn read_file_reads_within_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, "hello world").unwrap();
        let roots = vec![dir.path().to_string_lossy().into_owned()];
        let tool = ReadFile { roots };
        let args = json!({ "path": path.to_string_lossy().as_ref() });
        assert_eq!(tool.run(&args).unwrap(), "hello world");
    }

    #[test]
    fn web_fetch_blocks_private_url() {
        let tool = WebFetch;
        let args = json!({ "url": "http://localhost:8080/secret" });
        let err = tool.run(&args).unwrap_err();
        assert!(err.contains("blocked") || err.contains("invalid"));
    }

    #[test]
    fn web_fetch_blocks_non_http_scheme() {
        let tool = WebFetch;
        let args = json!({ "url": "file:///etc/passwd" });
        let err = tool.run(&args).unwrap_err();
        assert!(err.contains("blocked") || err.contains("invalid"));
    }

    #[test]
    fn web_search_unconfigured_returns_err() {
        let tool = WebSearch { endpoint: String::new() };
        let args = json!({ "query": "rust programming" });
        let err = tool.run(&args).unwrap_err();
        assert!(err.contains("not configured"));
    }

    #[test]
    fn with_config_offline_excludes_online_tools() {
        let mut cfg = crate::config::Config::default();
        cfg.offline_mode = true;
        let r = ToolRegistry::with_config(&cfg);
        let tools = r.openai_tools();
        let names: Vec<&str> = tools.as_array().unwrap().iter()
            .map(|t| t["function"]["name"].as_str().unwrap()).collect();
        assert!(!names.contains(&"web_fetch"), "web_fetch must be absent in offline mode");
        assert!(!names.contains(&"web_search"), "web_search must be absent in offline mode");
        assert!(names.contains(&"get_time"));
        assert!(names.contains(&"calculate"));
        assert!(names.contains(&"read_file"));
    }

    #[test]
    fn with_config_online_includes_online_tools() {
        let mut cfg = crate::config::Config::default();
        cfg.offline_mode = false;
        let r = ToolRegistry::with_config(&cfg);
        let tools = r.openai_tools();
        let names: Vec<&str> = tools.as_array().unwrap().iter()
            .map(|t| t["function"]["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"web_fetch"));
        assert!(names.contains(&"web_search"));
    }
}
