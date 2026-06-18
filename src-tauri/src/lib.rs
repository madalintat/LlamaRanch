mod config;
mod scanner;
mod launch;
mod server;
mod commands;

use commands::AppConfig;
use server::SharedServer;
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime, WindowEvent};

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
            commands::router_status,
            commands::load_model,
            commands::unload_model,
            commands::open_webui,
            commands::get_config,
            commands::set_config,
            commands::restart_router,
            commands::llama_cpp_version,
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open LlamaRanch", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LlamaRanch")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "quit" => {
                        if let Some(srv) = app.try_state::<SharedServer>() {
                            server::stop(&mut srv.lock());
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            start_router(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
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

/// Generate the model preset and (re)start the persistent router, then poll its
/// health in the background and flip the status to running/error.
pub fn start_router<R: Runtime>(app: &AppHandle<R>) {
    let cfg = app.state::<AppConfig>().0.lock().unwrap().clone();
    let models = scanner::scan(Path::new(&cfg.models_dir));

    let preset_path = config::config_path()
        .parent()
        .map(|p| p.join("models.ini"))
        .unwrap_or_else(|| std::path::PathBuf::from("models.ini"));
    if let Some(parent) = preset_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&preset_path, server::preset_for(&models));

    {
        let srv = app.state::<SharedServer>();
        let mut s = srv.lock();
        if let Err(e) = server::start_router(&mut s, &cfg, &preset_path.to_string_lossy()) {
            s.status = format!("error: {e}");
            return;
        }
    }

    let app = app.clone();
    let port = cfg.port;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if Instant::now() > deadline {
                let srv = app.state::<SharedServer>();
                let mut s = srv.lock();
                let err = server::drain_stderr(&mut s);
                server::stop(&mut s);
                s.status = format!("error: router did not start\n{err}");
                break;
            }
            if server::health_ok(port) {
                app.state::<SharedServer>().lock().status = "running".into();
                break;
            }
            {
                let srv = app.state::<SharedServer>();
                let mut s = srv.lock();
                if let Some(child) = s.child.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        let err = server::drain_stderr(&mut s);
                        server::stop(&mut s);
                        s.status = format!("error: router exited\n{err}");
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
