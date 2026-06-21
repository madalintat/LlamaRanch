mod brain;
mod catalog;
mod config;
mod scanner;
mod launch;
mod server;
mod commands;
mod gguf;

use commands::AppConfig;
use server::SharedServer;
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WindowEvent};

/// Timestamp of the last hide-on-blur, so a tray click that *caused* the blur
/// doesn't immediately re-open the window (popover click/blur race).
#[derive(Default)]
struct LastHide(std::sync::Mutex<Option<Instant>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut cfg = config::load_from(&config::config_path());
    // If the stored llama-server path went missing (or a fresh config picked the
    // historical default on a brew-only Mac), re-resolve and persist the fix.
    let resolved = config::ensure_server_bin(&cfg.server_bin);
    if resolved != cfg.server_bin {
        cfg.server_bin = resolved;
        if let Err(e) = config::save_to(&config::config_path(), &cfg) {
            eprintln!("llamaranch: failed to persist resolved server_bin: {e}");
        }
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
        .manage(brain::Sessions::default())
        .manage(brain::pool::Pool::default())
        .manage(LastHide::default())
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
            commands::model_info,
            commands::set_model_config,
            brain::chat_new_session,
            brain::chat_send,
            brain::chat_cancel,
            brain::pool::model_pool,
        ])
        .setup(|app| {
            // macOS: menubar-only app — no Dock icon, no Cmd-Tab entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open = MenuItem::with_id(app, "open", "Open LlamaRanch", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            #[cfg(target_os = "macos")]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-glyph.png"
            ))
            .expect("tray glyph png");
            #[cfg(not(target_os = "macos"))]
            let tray_icon = app.default_window_icon().unwrap().clone();

            let mut tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("LlamaRanch");
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon_as_template(true);
            }
            tray.menu(&menu)
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
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_popover(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            start_router(app.handle());

            let h = app.handle().clone();
            std::thread::spawn(move || {
                let cfg = h.state::<AppConfig>().0.lock().unwrap().clone();
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = crate::server::load(cfg.port, &cfg.general_model);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let _ = window.hide();
                    api.prevent_close();
                }
                // Popover dismiss — only the main panel hides on blur. (Gating to
                // "main" keeps a Settings-window blur from stamping the debounce
                // and swallowing the next tray click.)
                #[cfg(target_os = "macos")]
                WindowEvent::Focused(false) if window.label() == "main" => {
                    if let Some(state) = window.app_handle().try_state::<LastHide>() {
                        *state.0.lock().unwrap() = Some(Instant::now());
                    }
                    let _ = window.hide();
                }
                _ => {}
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
    let _ = std::fs::write(&preset_path, server::preset_for(&models, &cfg.model_config));

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

/// Show the window anchored just below the tray icon described by `rect`.
/// In Tauri 2.11.3, `Rect.position` and `Rect.size` are `dpi::Position` /
/// `dpi::Size` enums (not Results), so we match directly on the Physical variants.
fn show_popover<R: Runtime>(app: &AppHandle<R>, rect: tauri::Rect) {
    if let Some(win) = app.get_webview_window("main") {
        let icon = match (rect.position, rect.size) {
            (tauri::Position::Physical(p), tauri::Size::Physical(s)) => Some((p, s)),
            _ => None,
        };
        if let Some((p, s)) = icon {
            let win_w = win.outer_size().map(|w| w.width as i32).unwrap_or(420);
            let x = p.x + (s.width as i32) / 2 - win_w / 2;
            let y = p.y + s.height as i32;
            let _ = win.set_position(PhysicalPosition::new(x.max(0), y.max(0)));
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Toggle the popover: hide if visible, else show under the tray icon —
/// unless a hide-on-blur happened within the debounce window (the click that
/// caused the blur), in which case do nothing (stay closed).
fn toggle_popover<R: Runtime>(app: &AppHandle<R>, rect: tauri::Rect) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
    }
    if let Some(state) = app.try_state::<LastHide>() {
        if let Some(t) = *state.0.lock().unwrap() {
            if t.elapsed() < Duration::from_millis(250) {
                return;
            }
        }
    }
    show_popover(app, rect);
}

fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
