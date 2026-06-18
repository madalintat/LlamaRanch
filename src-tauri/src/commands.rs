use crate::config::{self, Config};
use crate::launch;
use crate::scanner;
use crate::server::{self, SharedServer};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, State};

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
