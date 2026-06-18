use crate::config::{self, Config};
use crate::launch;
use crate::scanner::{self, Model};
use crate::server::{self, SharedServer};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

pub struct AppConfig(pub Mutex<Config>);

#[derive(Serialize)]
pub struct ModelView {
    #[serde(flatten)]
    pub model: Model,
    pub placement: String,
}

#[derive(Serialize)]
pub struct StatusView {
    pub status: String,
    pub model_id: Option<String>,
    pub endpoint: String,
}

fn endpoint(cfg: &Config) -> String {
    format!("http://127.0.0.1:{}/v1", cfg.port)
}

#[tauri::command]
pub fn list_models(cfg: State<AppConfig>) -> Vec<ModelView> {
    let cfg = cfg.0.lock().unwrap().clone();
    scanner::scan(Path::new(&cfg.models_dir))
        .into_iter()
        .map(|m| {
            let placement = launch::placement_for(m.size_bytes).to_string();
            ModelView { model: m, placement }
        })
        .collect()
}

#[tauri::command]
pub fn server_status(srv: State<SharedServer>, cfg: State<AppConfig>) -> StatusView {
    let s = srv.lock();
    let cfg = cfg.0.lock().unwrap();
    StatusView {
        status: s.status.clone(),
        model_id: s.model_id.clone(),
        endpoint: endpoint(&cfg),
    }
}

#[tauri::command]
pub fn start_server(
    model_id: String,
    srv: State<SharedServer>,
    cfg: State<AppConfig>,
) -> Result<(), String> {
    let cfg = cfg.0.lock().unwrap().clone();
    let model = scanner::scan(Path::new(&cfg.models_dir))
        .into_iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("model not found: {model_id}"))?;
    let args = launch::flags_for(&model, &cfg);

    {
        let mut s = srv.lock();
        server::start(&mut s, &cfg.server_bin, &args, &model_id)?;
    }

    let srv_inner = srv.inner().clone_handle();
    let port = cfg.port;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if Instant::now() > deadline {
                let mut s = srv_inner.lock();
                let err = server::drain_stderr(&mut s);
                server::stop(&mut s);
                s.status = format!("error: timed out starting llama-server\n{err}");
                break;
            }
            if server::health_ok(port) {
                let mut s = srv_inner.lock();
                if s.child.is_some() {
                    s.status = "running".into();
                }
                break;
            }
            {
                let mut s = srv_inner.lock();
                if let Some(child) = s.child.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        let err = server::drain_stderr(&mut s);
                        server::stop(&mut s);
                        s.status = format!("error: llama-server exited\n{err}");
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(800));
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_server(srv: State<SharedServer>) {
    let mut s = srv.lock();
    server::stop(&mut s);
}

#[tauri::command]
pub fn open_webui(cfg: State<AppConfig>) -> Result<(), String> {
    let port = cfg.0.lock().unwrap().port;
    let url = format!("http://127.0.0.1:{}", port);
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_config(cfg: State<AppConfig>) -> Config {
    cfg.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_config(new_cfg: Config, cfg: State<AppConfig>) -> Result<(), String> {
    *cfg.0.lock().unwrap() = new_cfg.clone();
    config::save_to(&config::config_path(), &new_cfg).map_err(|e| e.to_string())
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
