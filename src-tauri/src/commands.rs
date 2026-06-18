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
use tauri::{AppHandle, Emitter, State};

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

#[tauri::command]
pub fn list_catalog(cfg: State<AppConfig>) -> Vec<CatalogView> {
    let dir = cfg.0.lock().unwrap().models_dir.clone();
    catalog::catalog()
        .iter()
        .map(|e| {
            let dest = Path::new(&dir).join(e.group).join(e.file);
            CatalogView {
                id: e.id.into(),
                name: e.name.into(),
                description: e.description.into(),
                group: e.group.into(),
                approx_gb: e.approx_gb,
                installed: dest.exists(),
            }
        })
        .collect()
}

/// Stream a catalog model from Hugging Face into the models dir, emitting
/// progress events, then restart the router so it appears. Returns immediately.
#[tauri::command]
pub fn download_model(id: String, app: AppHandle, cfg: State<AppConfig>) -> Result<(), String> {
    let c = cfg.0.lock().unwrap().clone();
    let entry = catalog::find(&id).ok_or_else(|| format!("unknown model: {id}"))?;
    let dest = Path::new(&c.models_dir).join(entry.group).join(entry.file);
    let url = format!(
        "https://huggingface.co/{}/resolve/main/{}",
        entry.repo, entry.file
    );
    let token = c.hf_token.clone();

    std::thread::spawn(move || {
        let app2 = app.clone();
        let res = download_file(&url, &dest, &token, |done, total| {
            let _ = app2.emit(
                "download:progress",
                serde_json::json!({ "id": id, "done": done, "total": total }),
            );
        });
        match res {
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
    std::fs::remove_file(&model.path).map_err(|e| e.to_string())?;
    if let Some(mm) = &model.mmproj_path {
        let _ = std::fs::remove_file(mm);
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
