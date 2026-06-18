mod config;
mod scanner;
mod launch;
mod server;
mod commands;

use commands::AppConfig;
use server::SharedServer;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

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
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show LlamaRanch", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LlamaRanch")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        if let Some(srv) = app.try_state::<SharedServer>() {
                            server::stop(&mut srv.lock());
                        }
                        app.exit(0);
                    }
                    "show" => toggle_window(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                position_near(&win, position);
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
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

// Place the panel next to the tray click: below the cursor when the bar is in
// the top half of the screen, above it when in the bottom half. Clamped to the
// monitor so it never spills off-screen, regardless of bar position.
fn position_near<R: tauri::Runtime>(
    win: &tauri::WebviewWindow<R>,
    click: tauri::PhysicalPosition<f64>,
) {
    let size = win
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(400, 600));
    let (mx, my, mw, mh) = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        })
        .unwrap_or((0.0, 0.0, 1920.0, 1080.0));

    let w = size.width as f64;
    let h = size.height as f64;
    let gap = 8.0;

    let x = (click.x - w / 2.0).max(mx + 6.0).min(mx + mw - w - 6.0);
    let y = if click.y < my + mh / 2.0 {
        click.y + gap
    } else {
        click.y - h - gap
    };
    let y = y.max(my + 6.0).min(my + mh - h - 6.0);

    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

fn toggle_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}
