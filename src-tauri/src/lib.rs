mod config;
mod scanner;
mod launch;
mod server;
mod commands;

use commands::AppConfig;
use scanner::Model;
use server::SharedServer;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

const TRAY_ID: &str = "llamaranch-tray";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::load_from(&config::config_path());
    let shared = SharedServer::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppConfig(Mutex::new(cfg)))
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            commands::list_models,
            commands::server_status,
            commands::start_server,
            commands::stop_server,
            commands::open_webui,
            commands::get_config,
            commands::set_config,
            commands::llama_cpp_version,
        ])
        .setup(|app| {
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LlamaRanch")
                .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()))
                .build(app)?;
            rebuild_menu(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(srv) = app_handle.try_state::<SharedServer>() {
                    server::stop(&mut srv.lock());
                }
            }
        });
}

/// Build the tray menu from the current config + server state and install it.
fn rebuild_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let cfg = config::load_from(&config::config_path());
    let (status, running_id) = {
        let s = app.state::<SharedServer>();
        let g = s.lock();
        (g.status.clone(), g.model_id.clone())
    };

    let status_label = if status == "running" {
        format!("serving {}", running_id.clone().unwrap_or_default())
    } else if status == "starting" {
        "starting...".to_string()
    } else if status.starts_with("error") {
        "error - check terminal".to_string()
    } else {
        "idle".to_string()
    };

    let header = MenuItemBuilder::new(format!("LlamaRanch  -  {status_label}"))
        .enabled(false)
        .build(app)?;
    let mut mb = MenuBuilder::new(app).item(&header).separator();

    let models = scanner::scan(Path::new(&cfg.models_dir));
    if models.is_empty() {
        let none = MenuItemBuilder::new("No models found in models dir")
            .enabled(false)
            .build(app)?;
        mb = mb.item(&none);
    } else {
        // group in first-seen order
        let mut order: Vec<String> = Vec::new();
        let mut by: HashMap<String, Vec<&Model>> = HashMap::new();
        for m in &models {
            if !by.contains_key(&m.group) {
                order.push(m.group.clone());
            }
            by.entry(m.group.clone()).or_default().push(m);
        }
        for g in &order {
            let glabel = MenuItemBuilder::new(g.to_uppercase())
                .enabled(false)
                .build(app)?;
            mb = mb.item(&glabel);
            for m in &by[g] {
                let serving =
                    status == "running" && running_id.as_deref() == Some(m.id.as_str());
                let label = format!(
                    "{}   {:.1} GB - {}",
                    m.name,
                    m.size_bytes as f64 / 1e9,
                    launch::placement_for(m.size_bytes)
                );
                let item = CheckMenuItemBuilder::new(label)
                    .id(format!("m:{}", m.id))
                    .checked(serving)
                    .build(app)?;
                mb = mb.item(&item);
            }
        }
    }

    let menu = mb
        .separator()
        .text("webui", "Open WebUI")
        .text("copy", "Copy endpoint")
        .separator()
        .text("settings", "Edit settings...")
        .text("quit", "Quit")
        .build()?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn handle_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "quit" => {
            if let Some(srv) = app.try_state::<SharedServer>() {
                server::stop(&mut srv.lock());
            }
            app.exit(0);
        }
        "webui" => {
            let port = config::load_from(&config::config_path()).port;
            let _ = std::process::Command::new("xdg-open")
                .arg(format!("http://127.0.0.1:{port}"))
                .spawn();
        }
        "copy" => {
            let port = config::load_from(&config::config_path()).port;
            copy_endpoint(port);
        }
        "settings" => open_settings(app),
        other => {
            if let Some(model_id) = other.strip_prefix("m:") {
                toggle_model(app, model_id.to_string());
            }
        }
    }
}

fn toggle_model<R: Runtime>(app: &AppHandle<R>, model_id: String) {
    let running_same = {
        let s = app.state::<SharedServer>();
        let g = s.lock();
        g.status == "running" && g.model_id.as_deref() == Some(model_id.as_str())
    };
    if running_same {
        let s = app.state::<SharedServer>();
        server::stop(&mut s.lock());
        let _ = rebuild_menu(app);
        return;
    }
    start_model(app, model_id);
}

fn start_model<R: Runtime>(app: &AppHandle<R>, model_id: String) {
    let cfg = config::load_from(&config::config_path());
    let model = match scanner::scan(Path::new(&cfg.models_dir))
        .into_iter()
        .find(|m| m.id == model_id)
    {
        Some(m) => m,
        None => return,
    };
    let args = launch::flags_for(&model, &cfg);
    {
        let s = app.state::<SharedServer>();
        let mut g = s.lock();
        if let Err(e) = server::start(&mut g, &cfg.server_bin, &args, &model_id) {
            g.status = format!("error: {e}");
        }
    }
    let _ = rebuild_menu(app);

    // poll /health in the background; flip to running or error, then refresh menu
    let app = app.clone();
    let port = cfg.port;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if Instant::now() > deadline {
                let s = app.state::<SharedServer>();
                let mut g = s.lock();
                server::stop(&mut g);
                g.status = "error: timed out".into();
                break;
            }
            if server::health_ok(port) {
                let s = app.state::<SharedServer>();
                let mut g = s.lock();
                if g.child.is_some() {
                    g.status = "running".into();
                }
                break;
            }
            {
                let s = app.state::<SharedServer>();
                let mut g = s.lock();
                if let Some(child) = g.child.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        server::stop(&mut g);
                        g.status = "error: llama-server exited".into();
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(800));
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = rebuild_menu(&app2);
        });
    });
}

fn copy_endpoint(port: u16) {
    let url = format!("http://127.0.0.1:{port}/v1");
    if let Ok(mut child) = std::process::Command::new("xclip")
        .args(["-selection", "clipboard"])
        .stdin(std::process::Stdio::piped())
        .spawn()
    {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(url.as_bytes());
        }
    }
}

fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    let path = config::config_path();
    if !path.exists() {
        let cfg = app.state::<AppConfig>().0.lock().unwrap().clone();
        let _ = config::save_to(&path, &cfg);
    }
    let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
}
