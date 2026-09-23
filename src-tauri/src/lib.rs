//! Tauri core: owns app lifecycle, settings and the Python sidecar process; it never
//! proxies API calls (D10). Session 0 is the empty shell — the modules below are
//! stubs filled in by later sessions (docs/session-plan.md).

mod bootstrap;
mod commands;
mod config;
mod layout;
mod paths;
mod platform;
mod sidecar;
mod update_check;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
