//! Tauri core: owns app lifecycle, settings and the Python sidecar process; it never
//! proxies API calls (D10).

mod bootstrap;
mod commands;
mod config;
mod error;
mod layout;
mod paths;
mod platform;
mod sidecar;
mod update_check;

use tauri::{Manager, RunEvent, WindowEvent};

use commands::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_boot_state,
            commands::set_locale,
            commands::accept_terms,
            commands::probe_platform,
            commands::set_device_choice,
            commands::inspect_data_root,
            commands::set_data_root,
            commands::start_setup,
            commands::get_setup_progress,
            commands::get_sidecar_port,
            commands::retry_startup,
        ])
        .setup(|app| {
            commands::initialize(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Graceful path: tear the sidecar down as soon as the window closes.
            if let WindowEvent::CloseRequested { .. } = event {
                window.state::<AppState>().shutdown();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Backstop for every other way out. A forced quit skips this, but then the
            // job object (Windows) or the sidecar's parent-pid watchdog still ends it.
            if let RunEvent::Exit = event {
                app.state::<AppState>().shutdown();
            }
        });
}
