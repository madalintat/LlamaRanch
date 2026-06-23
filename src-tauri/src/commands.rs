use crate::catalog;
use crate::config::{self, Config, ModelOverride};
use crate::gguf;
use crate::launch;
use crate::scanner;
use crate::server::{self, SharedServer};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub label: String,
    pub scope: String,  // "local" | "online"
    pub enabled: bool,
    pub note: String,
}

#[tauri::command]
pub fn list_tools(cfg: State<AppConfig>) -> Vec<ToolInfo> {
    let c = cfg.0.lock().unwrap().clone();
    vec![
        ToolInfo {
            name: "get_time".into(),
            label: "Clock".into(),
            scope: "local".into(),
            enabled: true,
            note: String::new(),
        },
        ToolInfo {
            name: "calculate".into(),
            label: "Calculator".into(),
            scope: "local".into(),
            enabled: true,
            note: String::new(),
        },
        ToolInfo {
            name: "read_file".into(),
            label: "Filesystem".into(),
            scope: "local".into(),
            enabled: !c.allowed_dirs.is_empty(),
            note: if c.allowed_dirs.is_empty() {
                "grant a folder in Settings to enable".into()
            } else {
                String::new()
            },
        },
        ToolInfo {
            name: "web_fetch".into(),
            label: "Web fetch".into(),
            scope: "online".into(),
            enabled: !c.offline_mode,
            note: if c.offline_mode { "offline".into() } else { String::new() },
        },
        ToolInfo {
            name: "web_search".into(),
            label: "Web search".into(),
            scope: "online".into(),
            enabled: !c.offline_mode && !c.searxng_url.is_empty(),
            note: if c.offline_mode {
                "offline".into()
            } else if c.searxng_url.is_empty() {
                "set SearXNG URL in Settings".into()
            } else {
                String::new()
            },
        },
    ]
}

pub struct AppConfig(pub Mutex<Config>);

#[derive(Serialize)]
pub struct ModelView {
    pub id: String,
    pub name: String,
    pub group: String,
    pub size_bytes: u64,
    pub vision: bool,
    pub placement: String,
    pub status: String, // unloaded | loading | loaded | sleeping | downloading | error
    pub local: bool,
    pub need_download: bool,
}

#[derive(Serialize)]
pub struct RouterStatus {
    pub status: String, // starting | running | error: .. | stopped
    pub endpoint: String,
}

fn cfg_of(cfg: &State<AppConfig>) -> Config {
    cfg.0.lock().unwrap().clone()
}

/// The router exposes a no-model "default" entry; never show it as a model.
fn should_list(id: &str) -> bool {
    id != "default"
}

/// The HuggingFace hub cache directory the router downloads into, honoring the
/// standard env overrides, else `~/.cache/huggingface/hub`.
fn hf_hub_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HF_HUB_CACHE") {
        return Some(PathBuf::from(p));
    }
    if let Some(p) = std::env::var_os("HF_HOME") {
        return Some(PathBuf::from(p).join("hub"));
    }
    dirs::home_dir().map(|h| h.join(".cache").join("huggingface").join("hub"))
}

/// Path of the HF-cached GGUF for a router id like `org/repo:QUANT`, found under
/// `<hub>/models--org--repo/snapshots/*/`. Quant tag selects the file; mmproj is
/// skipped. Returns the largest matching weight file.
fn hf_cache_file(hub: &Path, id: &str) -> Option<PathBuf> {
    let (repo, quant) = match id.rsplit_once(':') {
        Some((r, q)) => (r, Some(q.to_lowercase())),
        None => (id, None),
    };
    let snapshots = hub
        .join(format!("models--{}", repo.replace('/', "--")))
        .join("snapshots");
    let mut best: Option<(u64, PathBuf)> = None;
    for snap in std::fs::read_dir(&snapshots).ok()?.flatten() {
        let p = snap.path();
        if !p.is_dir() {
            continue;
        }
        if let Ok(files) = std::fs::read_dir(&p) {
            for f in files.flatten() {
                let fp = f.path();
                let name = match fp.file_name() {
                    Some(n) => n.to_string_lossy().to_lowercase(),
                    None => continue,
                };
                if !name.ends_with(".gguf") || name.starts_with("mmproj") {
                    continue;
                }
                if let Some(q) = &quant {
                    if !name.contains(q.as_str()) {
                        continue;
                    }
                }
                let sz = std::fs::metadata(&fp).map(|m| m.len()).unwrap_or(0);
                if best.as_ref().is_none_or(|(b, _)| sz > *b) {
                    best = Some((sz, fp));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

fn hf_cache_size(hub: &Path, id: &str) -> Option<u64> {
    hf_cache_file(hub, id)
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
}

/// A downloaded model's on-disk gguf: local models dir or the HF cache.
struct Resolved {
    path: PathBuf,
    file_bytes: u64,
    local: bool,
    mmproj_path: Option<PathBuf>,
}

fn resolve_model(cfg: &Config, id: &str) -> Option<Resolved> {
    if let Some(m) = scanner::scan(Path::new(&cfg.models_dir))
        .into_iter()
        .find(|m| m.id == id)
    {
        return Some(Resolved {
            path: PathBuf::from(&m.path),
            file_bytes: m.size_bytes,
            local: true,
            mmproj_path: m.mmproj_path.as_ref().map(PathBuf::from),
        });
    }
    let hub = hf_hub_dir()?;
    let path = hf_cache_file(&hub, id)?;
    let file_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Some(Resolved { path, file_bytes, local: false, mmproj_path: None })
}

/// Merge a router model with local info into a view for the UI. `cached_size` is
/// the HF-cache size for a non-local but already-downloaded model (0 if unknown).
fn to_view(r: server::RouterModel, fs: &[scanner::Model], cached_size: u64) -> ModelView {
    match fs.iter().find(|m| m.id == r.id) {
        Some(m) => ModelView {
            placement: launch::placement_for(m.size_bytes).to_string(),
            size_bytes: m.size_bytes,
            group: m.group.clone(),
            name: m.name.clone(),
            local: true,
            id: r.id,
            vision: r.vision || m.mmproj_path.is_some(),
            status: r.status,
            need_download: false, // it's on disk - never "Get & Load"
        },
        // Not in our models dir. If the router has it cached (need_download =
        // false) it is downloaded and usable now; only a true need_download is
        // "cloud". Show the cached size when we can resolve it.
        None => ModelView {
            placement: if cached_size > 0 {
                launch::placement_for(cached_size).to_string()
            } else {
                String::new()
            },
            size_bytes: cached_size,
            group: if r.need_download {
                "available".to_string()
            } else {
                "downloaded".to_string()
            },
            name: r.id.clone(),
            local: false,
            id: r.id,
            vision: r.vision,
            status: r.status,
            need_download: r.need_download,
        },
    }
}

#[tauri::command]
pub fn list_models(cfg: State<AppConfig>) -> Vec<ModelView> {
    let cfg = cfg_of(&cfg);
    let fs = scanner::scan(Path::new(&cfg.models_dir));
    let hub = hf_hub_dir();
    server::list_models(cfg.port)
        .into_iter()
        .filter(|r| should_list(&r.id))
        .map(|r| {
            let cached = match (&hub, r.need_download) {
                (Some(h), false) => hf_cache_size(h, &r.id).unwrap_or(0),
                _ => 0,
            };
            to_view(r, &fs, cached)
        })
        .collect()
}

#[tauri::command]
pub fn router_status(srv: State<SharedServer>, cfg: State<AppConfig>) -> RouterStatus {
    let status = srv.lock().status.clone();
    let port = cfg.0.lock().unwrap().port;
    RouterStatus {
        status,
        endpoint: format!("http://127.0.0.1:{port}/v1"),
    }
}

#[tauri::command]
pub fn load_model(model_id: String, cfg: State<AppConfig>) -> Result<(), String> {
    let port = cfg.0.lock().unwrap().port;
    server::load(port, &model_id)
}

#[tauri::command]
pub fn unload_model(model_id: String, cfg: State<AppConfig>) -> Result<(), String> {
    let port = cfg.0.lock().unwrap().port;
    server::unload(port, &model_id)
}

#[tauri::command]
pub fn get_config(cfg: State<AppConfig>) -> Config {
    cfg.0.lock().unwrap().clone()
}

/// Save config, update in-memory state, and restart the router so changes
/// (port, models dir, idle timeout, network exposure) take effect.
#[tauri::command]
pub fn set_config(new_cfg: Config, cfg: State<AppConfig>, app: AppHandle) -> Result<(), String> {
    if new_cfg.port == 0 {
        return Err("Port must be greater than 0".into());
    }
    if !Path::new(&new_cfg.server_bin).exists() {
        return Err(format!("llama-server not found at {}", new_cfg.server_bin));
    }
    *cfg.0.lock().unwrap() = new_cfg.clone();
    config::save_to(&config::config_path(), &new_cfg).map_err(|e| e.to_string())?;
    crate::start_router(&app);
    Ok(())
}

#[tauri::command]
pub fn restart_router(app: AppHandle) {
    crate::start_router(&app);
}

/// Merge `new` paths into `existing`, preserving order and dropping duplicates
/// (an entry already present in `existing` or repeated within `new` is skipped).
/// Pure list logic, unit-tested below; the canonicalize step lives in the command.
fn merge_allowed(existing: &[String], new: &[String]) -> Vec<String> {
    let mut out = existing.to_vec();
    for p in new {
        if !out.iter().any(|e| e == p) {
            out.push(p.clone());
        }
    }
    out
}

/// Grant the agent file access to one or more paths. Each path is canonicalized
/// (paths that fail to resolve are skipped), merged into `allowed_dirs` without
/// duplicates, then the config is persisted. The router is NOT restarted: file
/// access reads `allowed_dirs` live and needs no relaunch. Returns the updated list.
#[tauri::command]
pub fn add_allowed_dirs(
    paths: Vec<String>,
    cfg: State<AppConfig>,
    _app: AppHandle,
) -> Result<Vec<String>, String> {
    let resolved: Vec<String> = paths
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    let mut c = cfg.0.lock().unwrap();
    c.allowed_dirs = merge_allowed(&c.allowed_dirs, &resolved);
    config::save_to(&config::config_path(), &c).map_err(|e| e.to_string())?;
    Ok(c.allowed_dirs.clone())
}

/// Revoke file access for one granted path (exact match). Persists and returns
/// the updated list. The router is NOT restarted (file access reads it live).
#[tauri::command]
pub fn remove_allowed_dir(
    path: String,
    cfg: State<AppConfig>,
    _app: AppHandle,
) -> Result<Vec<String>, String> {
    let mut c = cfg.0.lock().unwrap();
    c.allowed_dirs.retain(|p| p != &path);
    config::save_to(&config::config_path(), &c).map_err(|e| e.to_string())?;
    Ok(c.allowed_dirs.clone())
}

/// Names of directories we never descend into when listing granted files: build
/// output, VCS metadata, and dependency trees. Keeping the agent's view to source
/// files keeps the picker fast and the results relevant.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
];

/// How many filesystem entries we scan before giving up (a hard wall so a huge
/// tree can never hang the picker), and how many results we hand back.
const SCAN_CAP: usize = 5000;
const RESULT_CAP: usize = 30;

/// Score a candidate path against a lowercase query. Lower is better; `None`
/// means no match. Ranks exact basename, then basename prefix, then a basename
/// substring, then a path substring. Ties break on shorter path (closer to root).
fn match_score(path: &str, base: &str, q: &str) -> Option<usize> {
    if q.is_empty() {
        return Some(4);
    }
    if base == q {
        Some(0)
    } else if base.starts_with(q) {
        Some(1)
    } else if base.contains(q) {
        Some(2)
    } else if path.contains(q) {
        Some(3)
    } else {
        None
    }
}

/// Pure ranking/filter helper (unit-tested): keep paths whose basename or full
/// path matches `query` (case-insensitive substring), order by match quality,
/// and cap at `RESULT_CAP`. An empty query keeps the input order and just caps.
fn rank_matches(paths: &[String], query: &str) -> Vec<String> {
    let q = query.trim().to_lowercase();
    let mut scored: Vec<(usize, usize, &String)> = paths
        .iter()
        .enumerate()
        .filter_map(|(idx, p)| {
            let lower = p.to_lowercase();
            let base = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
            match_score(&lower, base, &q).map(|score| (score, idx, p))
        })
        .collect();
    // Stable on (score, original index): preserves walk order within a tier.
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(RESULT_CAP)
        .map(|(_, _, p)| p.clone())
        .collect()
}

/// Walk one granted root, pushing absolute file paths into `out`. Skips hidden
/// dotfiles/dirs and the noise dirs in `SKIP_DIRS`. Increments `scanned` for every
/// entry inspected and stops the whole walk once it crosses `SCAN_CAP`.
fn collect_files(root: &Path, out: &mut Vec<String>, scanned: &mut usize) {
    if *scanned >= SCAN_CAP {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if *scanned >= SCAN_CAP {
            return;
        }
        *scanned += 1;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue; // hidden dotfile or dotdir
        }
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect_files(&path, out, scanned);
        } else {
            out.push(path.to_string_lossy().into_owned());
        }
    }
}

/// Fuzzy-search the agent's GRANTED folders (`config.allowed_dirs` only, never the
/// whole disk) for files matching `query`. Each granted entry is walked: a directory
/// is listed recursively (skipping hidden + noise dirs), a file entry includes
/// itself. Only paths that pass the existing allowlist gate are kept. Bounded by
/// `SCAN_CAP` entries scanned and `RESULT_CAP` results, so it never hangs.
#[tauri::command]
pub fn list_allowed_files(query: String, cfg: State<AppConfig>) -> Vec<String> {
    let roots = cfg.0.lock().unwrap().allowed_dirs.clone();
    if roots.is_empty() {
        return Vec::new();
    }
    let mut found: Vec<String> = Vec::new();
    let mut scanned: usize = 0;
    for root in &roots {
        if scanned >= SCAN_CAP {
            break;
        }
        let rp = Path::new(root);
        if rp.is_dir() {
            collect_files(rp, &mut found, &mut scanned);
        } else if rp.is_file() {
            scanned += 1;
            found.push(rp.to_string_lossy().into_owned());
        }
    }
    // Keep only paths that pass the live read_file gate (under a granted root).
    found.retain(|p| crate::brain::tools::path_allowed(p, &roots));
    rank_matches(&found, &query)
}

#[derive(Serialize)]
pub struct CatalogView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub group: String,
    pub approx_gb: f64,
    pub installed: bool,
}

/// Where a catalog model installs to. Vision models (with an mmproj) get their
/// own subdirectory so the mmproj pairs unambiguously.
fn install_dir(models_dir: &str, entry: &catalog::CatalogEntry) -> PathBuf {
    if entry.mmproj.is_some() {
        Path::new(models_dir).join(entry.id)
    } else {
        Path::new(models_dir).join(entry.group)
    }
}

/// Tracks in-flight downloads the user has asked to cancel.
#[derive(Default)]
pub struct Cancels(pub Mutex<std::collections::HashSet<String>>);

impl Cancels {
    fn mark(&self, id: &str) {
        self.0.lock().unwrap().insert(id.to_string());
    }
    fn clear(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    fn is_cancelled(&self, id: &str) -> bool {
        self.0.lock().unwrap().contains(id)
    }
}

#[tauri::command]
pub fn list_catalog(cfg: State<AppConfig>) -> Vec<CatalogView> {
    let dir = cfg.0.lock().unwrap().models_dir.clone();
    catalog::catalog()
        .iter()
        .map(|e| CatalogView {
            id: e.id.into(),
            name: e.name.into(),
            description: e.description.into(),
            group: e.group.into(),
            approx_gb: e.approx_gb,
            installed: install_dir(&dir, e).join(e.file).exists(),
        })
        .collect()
}

#[tauri::command]
pub fn cancel_download(id: String, cancels: State<Cancels>) {
    cancels.mark(&id);
}

/// Stream a catalog model (and its mmproj for vision) from Hugging Face into the
/// models dir with progress events, then restart the router. Returns immediately.
#[tauri::command]
pub fn download_model(id: String, app: AppHandle, cfg: State<AppConfig>) -> Result<(), String> {
    let c = cfg.0.lock().unwrap().clone();
    let entry = catalog::find(&id).ok_or_else(|| format!("unknown model: {id}"))?;
    let dir = install_dir(&c.models_dir, entry);
    let token = c.hf_token.clone();

    // (url, dest) for the model and optional mmproj
    let mut files: Vec<(String, PathBuf)> = vec![(
        format!("https://huggingface.co/{}/resolve/main/{}", entry.repo, entry.file),
        dir.join(entry.file),
    )];
    if let Some(mm) = entry.mmproj {
        files.push((
            format!("https://huggingface.co/{}/resolve/main/{}", entry.repo, mm),
            dir.join(mm),
        ));
    }

    // reject a second concurrent download of the same model, and clear any
    // stale cancel flag from a previous run so this one isn't aborted instantly
    if files[0].1.with_extension("part").exists() {
        return Err("already downloading".into());
    }
    app.state::<Cancels>().clear(&id);

    std::thread::spawn(move || {
        let cancelled = || app.state::<Cancels>().is_cancelled(&id);
        let mut result: Result<(), String> = Ok(());
        for (url, dest) in &files {
            let app2 = app.clone();
            let idc = id.clone();
            result = download_file(url, dest, &token, &cancelled, move |done, total| {
                let _ = app2.emit(
                    "download:progress",
                    serde_json::json!({ "id": idc, "done": done, "total": total }),
                );
            });
            if result.is_err() {
                break;
            }
        }
        app.state::<Cancels>().clear(&id);
        match result {
            Ok(_) => {
                crate::start_router(&app);
                let _ = app.emit("download:done", serde_json::json!({ "id": id }));
            }
            Err(e) => {
                let _ = app.emit("download:error", serde_json::json!({ "id": id, "error": e }));
            }
        }
    });
    Ok(())
}

fn download_file(
    url: &str,
    dest: &Path,
    token: &str,
    cancelled: &dyn Fn() -> bool,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let mut req = ureq::get(url).timeout(Duration::from_secs(7200));
    if !token.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", token.trim()));
    }
    let resp = req.call().map_err(|e| e.to_string())?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let tmp: PathBuf = dest.with_extension("part");
    let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 20];
    let mut done: u64 = 0;
    let mut last: u64 = 0;
    loop {
        if cancelled() {
            drop(out);
            let _ = std::fs::remove_file(&tmp);
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last > (8 << 20) {
            progress(done, total);
            last = done;
        }
    }
    drop(out);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    progress(done, total.max(done));
    Ok(())
}

/// Remove a model's on-disk files. Local: the gguf (+ mmproj, + empty subdir).
/// Cached: ONLY this quant's gguf symlink and the blob it points to, then prune
/// the snapshot dir if it becomes empty - never the whole repo (other quants).
fn remove_model_files(c: &Config, r: &Resolved) -> Result<(), String> {
    if r.local {
        std::fs::remove_file(&r.path).map_err(|e| e.to_string())?;
        if let Some(mm) = &r.mmproj_path {
            let _ = std::fs::remove_file(mm);
        }
        if let Some(parent) = r.path.parent() {
            if parent != Path::new(&c.models_dir) {
                let _ = std::fs::remove_dir(parent);
            }
        }
        Ok(())
    } else {
        // Resolve and remove the blob the snapshot symlink points to (frees the
        // disk), then the symlink itself. read_link gives a path relative to the
        // snapshot dir (e.g. ../../blobs/<sha>); the OS resolves the `..` parts.
        if let Ok(target) = std::fs::read_link(&r.path) {
            if let Some(snap) = r.path.parent() {
                let _ = std::fs::remove_file(snap.join(&target));
            }
        }
        std::fs::remove_file(&r.path).map_err(|e| e.to_string())?;
        if let Some(snap) = r.path.parent() {
            let _ = std::fs::remove_dir(snap); // best-effort; only if now empty
        }
        Ok(())
    }
}

#[tauri::command]
pub fn delete_model(model_id: String, app: AppHandle, cfg: State<AppConfig>) -> Result<(), String> {
    let c = cfg_of(&cfg);
    let resolved =
        resolve_model(&c, &model_id).ok_or_else(|| "only downloaded models can be deleted".to_string())?;
    let _ = server::unload(c.port, &model_id);

    let removed = remove_model_files(&c, &resolved);

    // Drop the override only if the files actually went away.
    let save = if removed.is_ok() {
        let mut cc = cfg.0.lock().unwrap();
        cc.model_config.remove(&model_id);
        config::save_to(&config::config_path(), &cc).map_err(|e| e.to_string())
    } else {
        Ok(())
    };

    // Always restart so a partial failure never leaves the model unloaded.
    crate::start_router(&app);
    removed?;
    save
}

#[derive(Serialize)]
pub struct ModelInfoView {
    pub native_ctx: u32,
    pub file_bytes: u64,
    pub kv_per_token: u64,
    pub r#override: ModelOverride,
}

#[tauri::command]
pub fn model_info(model_id: String, cfg: State<AppConfig>) -> ModelInfoView {
    let c = cfg_of(&cfg);
    let r#override = c.model_config.get(&model_id).cloned().unwrap_or_default();
    let (native_ctx, file_bytes, kv_per_token) = match resolve_model(&c, &model_id) {
        Some(r) => match gguf::read_info(&r.path) {
            Some(info) => (info.n_ctx_train, r.file_bytes, gguf::kv_bytes_per_token(&info)),
            None => (0, r.file_bytes, 0),
        },
        None => (0, 0, 0),
    };
    ModelInfoView { native_ctx, file_bytes, kv_per_token, r#override }
}

#[tauri::command]
pub fn set_model_config(
    model_id: String,
    r#override: ModelOverride,
    cfg: State<AppConfig>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut c = cfg.0.lock().unwrap();
        if r#override == ModelOverride::default() {
            c.model_config.remove(&model_id);
        } else {
            c.model_config.insert(model_id, r#override);
        }
        config::save_to(&config::config_path(), &c).map_err(|e| e.to_string())?;
    }
    crate::start_router(&app);
    Ok(())
}

/// Validate, live-apply, and (only on success) persist a new set of global shortcut
/// accelerators. Registration is attempted before persisting: if any accelerator
/// fails (invalid combo or taken by another app), the old shortcuts are re-registered
/// so the user keeps working bindings, and an error is returned to the frontend.
#[tauri::command]
pub fn set_shortcuts(
    cmdbar: String,
    agent: String,
    settings: String,
    app: AppHandle,
    cfg: State<'_, AppConfig>,
) -> Result<(), String> {
    if cmdbar.trim().is_empty() {
        return Err("Command bar shortcut must not be empty".into());
    }
    if agent.trim().is_empty() {
        return Err("Agent shortcut must not be empty".into());
    }
    if settings.trim().is_empty() {
        return Err("Settings shortcut must not be empty".into());
    }

    // Snapshot current (working) shortcuts before attempting to apply the new ones.
    let (old_cmdbar, old_agent, old_settings) = {
        let c = cfg.0.lock().unwrap();
        (c.shortcut_cmdbar.clone(), c.shortcut_agent.clone(), c.shortcut_settings.clone())
    };

    // Attempt to register the new trio BEFORE persisting.
    if let Err(e) = crate::register_global_shortcuts(&app, &cmdbar, &agent, &settings) {
        // Roll back to old shortcuts so the user keeps working bindings.
        let _ = crate::register_global_shortcuts(&app, &old_cmdbar, &old_agent, &old_settings);
        return Err(e);
    }

    // Registration succeeded: now persist.
    {
        let mut c = cfg.0.lock().unwrap();
        c.shortcut_cmdbar = cmdbar;
        c.shortcut_agent = agent;
        c.shortcut_settings = settings;
        config::save_to(&config::config_path(), &c).map_err(|e| e.to_string())?;
    }

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_view_local_model_enriched() {
        let r = server::RouterModel {
            id: "Qwen3".into(),
            status: "loaded".into(),
            vision: false,
            need_download: false,
            hf_repo: None,
        };
        let fs = vec![scanner::Model {
            id: "Qwen3".into(),
            name: "Qwen3".into(),
            group: "chat".into(),
            path: "/m/q.gguf".into(),
            size_bytes: 2_000_000_000,
            mmproj_path: None,
        }];
        let v = to_view(r, &fs, 0);
        assert!(v.local);
        assert_eq!(v.size_bytes, 2_000_000_000);
        assert_eq!(v.group, "chat");
        assert_eq!(v.status, "loaded");
    }

    #[test]
    fn to_view_cloud_model_needs_download() {
        let r = server::RouterModel {
            id: "ggml-org/gemma:Q4".into(),
            status: "unloaded".into(),
            vision: true,
            need_download: true,
            hf_repo: Some("ggml-org/gemma".into()),
        };
        let v = to_view(r, &[], 0);
        assert!(!v.local);
        assert_eq!(v.size_bytes, 0);
        assert_eq!(v.group, "available");
        assert!(v.vision);
        assert!(v.need_download);
    }

    #[test]
    fn to_view_cached_model_shows_size_and_downloaded() {
        // need_download = false + not in our dir = downloaded elsewhere (HF cache);
        // it should report the cached size and the "downloaded" group, not "cloud".
        let r = server::RouterModel {
            id: "squ11z1/Mythos:Q4_K_M".into(),
            status: "unloaded".into(),
            vision: false,
            need_download: false,
            hf_repo: Some("squ11z1/Mythos".into()),
        };
        let v = to_view(r, &[], 1_900_000_000);
        assert!(!v.local);
        assert_eq!(v.size_bytes, 1_900_000_000);
        assert_eq!(v.group, "downloaded");
        assert!(!v.need_download);
        assert!(!v.placement.is_empty());
    }

    #[test]
    fn should_list_filters_default() {
        assert!(!should_list("default"));
        assert!(should_list("Qwen3"));
    }

    #[test]
    fn to_view_local_vision_from_mmproj() {
        let r = server::RouterModel {
            id: "MiniCPM".into(),
            status: "unloaded".into(),
            vision: false,
            need_download: false,
            hf_repo: None,
        };
        let fs = vec![scanner::Model {
            id: "MiniCPM".into(),
            name: "MiniCPM".into(),
            group: "vision".into(),
            path: "/m/v.gguf".into(),
            size_bytes: 500_000_000,
            mmproj_path: Some("/m/mmproj.gguf".into()),
        }];
        let v = to_view(r, &fs, 0);
        assert!(v.vision);
        assert!(v.local);
    }

    #[test]
    fn hf_cache_size_finds_quant_in_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let hub = dir.path();
        let snap = hub
            .join("models--squ11z1--Mythos-nano-GGUF")
            .join("snapshots")
            .join("abc123");
        std::fs::create_dir_all(&snap).unwrap();
        // a matching weight, a non-matching quant, and an mmproj to skip
        let f = std::fs::File::create(snap.join("mythos-nano-Q4_K_M.gguf")).unwrap();
        f.set_len(1_900_000_000).unwrap();
        std::fs::File::create(snap.join("mythos-nano-Q8_0.gguf"))
            .unwrap()
            .set_len(3_000_000_000)
            .unwrap();
        std::fs::File::create(snap.join("mmproj-Q4_K_M.gguf"))
            .unwrap()
            .set_len(500_000_000)
            .unwrap();

        let sz = hf_cache_size(hub, "squ11z1/Mythos-nano-GGUF:Q4_K_M");
        assert_eq!(sz, Some(1_900_000_000));
    }

    #[test]
    fn hf_cache_size_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(hf_cache_size(dir.path(), "nope/missing:Q4_K_M"), None);
    }

    #[test]
    fn hf_cache_file_returns_matching_path() {
        let dir = tempfile::tempdir().unwrap();
        let hub = dir.path();
        let snap = hub.join("models--squ11z1--Mythos-nano-GGUF").join("snapshots").join("abc");
        std::fs::create_dir_all(&snap).unwrap();
        let want = snap.join("mythos-nano-Q4_K_M.gguf");
        std::fs::File::create(&want).unwrap().set_len(1_900_000_000).unwrap();
        std::fs::File::create(snap.join("mmproj-Q4_K_M.gguf")).unwrap().set_len(5).unwrap();
        let got = hf_cache_file(hub, "squ11z1/Mythos-nano-GGUF:Q4_K_M").unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn merge_allowed_dedups_and_preserves_order() {
        let existing = vec!["/a".to_string(), "/b".to_string()];
        // "/b" is a dup of an existing entry; "/c" appears twice in `new`.
        let new = vec!["/b".to_string(), "/c".to_string(), "/c".to_string()];
        let merged = merge_allowed(&existing, &new);
        assert_eq!(
            merged,
            vec!["/a".to_string(), "/b".to_string(), "/c".to_string()]
        );
    }

    #[test]
    fn merge_allowed_empty_inputs() {
        assert!(merge_allowed(&[], &[]).is_empty());
        let one = vec!["/x".to_string()];
        assert_eq!(merge_allowed(&one, &[]), one);
        assert_eq!(merge_allowed(&[], &one), one);
    }

    #[test]
    fn rank_matches_orders_by_quality_and_caps() {
        let paths = vec![
            "/g/notes/readme.md".to_string(),
            "/g/src/main.rs".to_string(),
            "/g/deep/main_helpers.rs".to_string(),
            "/g/docs/MAIN_OVERVIEW.txt".to_string(),
            "/g/other/unrelated.json".to_string(),
        ];
        // Query "main": exact basename none, prefix "main.rs" and "main_helpers.rs"
        // and "MAIN_OVERVIEW.txt" (case-insensitive) rank above pure path/none.
        let out = rank_matches(&paths, "main");
        assert_eq!(out[0], "/g/src/main.rs"); // basename prefix, earliest
        assert!(out.contains(&"/g/deep/main_helpers.rs".to_string()));
        assert!(out.contains(&"/g/docs/MAIN_OVERVIEW.txt".to_string()));
        assert!(!out.contains(&"/g/other/unrelated.json".to_string())); // no match
    }

    #[test]
    fn rank_matches_exact_basename_first() {
        let paths = vec![
            "/g/a/config.toml".to_string(),
            "/g/b/config.toml.bak".to_string(),
        ];
        let out = rank_matches(&paths, "config.toml");
        assert_eq!(out[0], "/g/a/config.toml"); // exact basename beats prefix
    }

    #[test]
    fn rank_matches_empty_query_keeps_order_and_caps() {
        let paths: Vec<String> = (0..40).map(|i| format!("/g/f{i}.txt")).collect();
        let out = rank_matches(&paths, "");
        assert_eq!(out.len(), RESULT_CAP);
        assert_eq!(out[0], "/g/f0.txt"); // input order preserved
    }

    #[test]
    fn rank_matches_path_substring_only() {
        let paths = vec!["/g/widgets/thing.rs".to_string()];
        // "widgets" matches the path but not the basename "thing.rs".
        assert_eq!(rank_matches(&paths, "widgets"), vec!["/g/widgets/thing.rs"]);
        assert!(rank_matches(&paths, "zzz").is_empty());
    }

    #[test]
    fn resolve_model_local_first() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("chat");
        std::fs::create_dir_all(&models).unwrap();
        let f = models.join("MyModel.gguf");
        std::fs::File::create(&f).unwrap().set_len(2_000_000_000).unwrap();
        let cfg = Config {
            models_dir: dir.path().to_string_lossy().into_owned(),
            ..Default::default()
        };
        let r = resolve_model(&cfg, "MyModel").unwrap();
        assert!(r.local);
        assert_eq!(r.path, f);
        assert_eq!(r.file_bytes, 2_000_000_000);
    }

}
