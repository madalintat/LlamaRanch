use crate::catalog;
use crate::config::{self, Config};
use crate::launch;
use crate::scanner;
use crate::server::{self, SharedServer};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

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
}

#[derive(Serialize)]
pub struct RouterStatus {
    pub status: String, // starting | running | error: .. | stopped
    pub endpoint: String,
}

fn cfg_of(cfg: &State<AppConfig>) -> Config {
    cfg.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn list_models(cfg: State<AppConfig>) -> Vec<ModelView> {
    let cfg = cfg_of(&cfg);
    let router = server::list_models(cfg.port);
    scanner::scan(Path::new(&cfg.models_dir))
        .into_iter()
        .map(|m| {
            let status = router
                .iter()
                .find(|r| r.id == m.id)
                .map(|r| r.status.clone())
                .unwrap_or_else(|| "unloaded".into());
            ModelView {
                placement: launch::placement_for(m.size_bytes).to_string(),
                vision: m.mmproj_path.is_some(),
                id: m.id,
                name: m.name,
                group: m.group,
                size_bytes: m.size_bytes,
                status,
            }
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
pub fn open_webui(cfg: State<AppConfig>) -> Result<(), String> {
    let port = cfg.0.lock().unwrap().port;
    std::process::Command::new("xdg-open")
        .arg(format!("http://127.0.0.1:{port}"))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_config(cfg: State<AppConfig>) -> Config {
    cfg.0.lock().unwrap().clone()
}

/// Save config, update in-memory state, and restart the router so changes
/// (port, models dir, idle timeout, network exposure) take effect.
#[tauri::command]
pub fn set_config(new_cfg: Config, cfg: State<AppConfig>, app: AppHandle) -> Result<(), String> {
    *cfg.0.lock().unwrap() = new_cfg.clone();
    config::save_to(&config::config_path(), &new_cfg).map_err(|e| e.to_string())?;
    crate::start_router(&app);
    Ok(())
}

#[tauri::command]
pub fn restart_router(app: AppHandle) {
    crate::start_router(&app);
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
    cancels.0.lock().unwrap().insert(id);
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

    std::thread::spawn(move || {
        let cancelled = || {
            app.state::<Cancels>().0.lock().unwrap().contains(&id)
        };
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
        app.state::<Cancels>().0.lock().unwrap().remove(&id);
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

#[tauri::command]
pub fn delete_model(model_id: String, app: AppHandle, cfg: State<AppConfig>) -> Result<(), String> {
    let dir = cfg.0.lock().unwrap().models_dir.clone();
    let model = scanner::scan(Path::new(&dir))
        .into_iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("not found: {model_id}"))?;
    let path = PathBuf::from(&model.path);
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    if let Some(mm) = &model.mmproj_path {
        let _ = std::fs::remove_file(mm);
    }
    // remove the model's own subdirectory if it's now empty (vision installs)
    if let Some(parent) = path.parent() {
        if parent != Path::new(&dir) {
            let _ = std::fs::remove_dir(parent);
        }
    }
    crate::start_router(&app);
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
