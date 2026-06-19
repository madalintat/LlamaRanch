mod catalog;
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
    let mut cfg = config::load_from(&config::config_path());
    // If the stored llama-server path went missing (or a fresh config picked the
    // historical default on a brew-only Mac), re-resolve and persist the fix.
    let resolved = config::ensure_server_bin(&cfg.server_bin);
    if resolved != cfg.server_bin {
        cfg.server_bin = resolved;
        let _ = config::save_to(&config::config_path(), &cfg);
    }
    let shared = SharedServer::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppConfig(Mutex::new(cfg)))
        .manage(shared)
        .manage(commands::Cancels::default())
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
            commands::list_catalog,
            commands::download_model,
            commands::cancel_download,
            commands::delete_model,
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

    if !Path::new(&cfg.server_bin).exists() {
        app.state::<SharedServer>().lock().status =
            format!("error: llama-server not found at {}", cfg.server_bin);
        return;
    }

    let models = scanner::scan(Path::new(&cfg.models_dir));

    let preset_path = server::preset_path();
    if let Some(parent) = preset_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&preset_path, server::preset_for(&models));

    // Capture the generation of the router we just started; if another
    // start_router runs later (settings change, download, delete), `generation`
    // advances and this poll thread bails without touching the new router.
    let generation = {
        let srv = app.state::<SharedServer>();
        let mut s = srv.lock();
        if let Err(e) = server::start_router(&mut s, &cfg, &preset_path.to_string_lossy()) {
            s.status = format!("error: {e}");
            return;
        }
        s.generation
    };

    let app = app.clone();
    let port = cfg.port;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            // someone restarted the router; stop watching this one
            if app.state::<SharedServer>().lock().generation != generation {
                return;
            }
            if server::health_ok(port) {
                let srv = app.state::<SharedServer>();
                let mut s = srv.lock();
                if s.generation == generation {
                    s.status = "running".into();
                }
                return;
            }
            {
                let srv = app.state::<SharedServer>();
                let mut s = srv.lock();
                if s.generation != generation {
                    return;
                }
                if let Some(child) = s.child.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        server::stop(&mut s);
                        s.status = format!("error: router exited\n{}", server::router_log_tail());
                        return;
                    }
                }
                if Instant::now() > deadline {
                    server::stop(&mut s);
                    s.status =
                        format!("error: router did not start\n{}", server::router_log_tail());
                    return;
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
