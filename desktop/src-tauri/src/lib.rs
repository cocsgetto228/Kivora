//! Kivora desktop shell.
//!
//! The shell is intentionally thin: it hosts the same web client the browser
//! runs, and adds the three things a browser cannot provide — a key in the OS
//! credential store, unlock throttling the page cannot reset, and a window
//! whose permissions are enumerated in `capabilities/default.json`.

mod core;

use std::path::PathBuf;

use tauri::{Manager, State};

struct AppState {
    data_dir: PathBuf,
}

#[tauri::command]
fn core_info(account: String) -> core::CoreInfo {
    core::info(&account)
}

/// Returns the device half of the vault key. The web layer combines it with
/// the user's password; neither half alone opens the vault.
#[tauri::command]
fn device_secret(state: State<'_, AppState>, account: String) -> Result<String, String> {
    core::device_secret(&state.data_dir, &account)
}

#[tauri::command]
fn unlock_delay(state: State<'_, AppState>, account: String) -> u64 {
    core::unlock_delay(&state.data_dir, &account)
}

#[tauri::command]
fn note_unlock_failure(state: State<'_, AppState>, account: String) -> u64 {
    core::note_unlock_failure(&state.data_dir, &account)
}

#[tauri::command]
fn note_unlock_success(state: State<'_, AppState>, account: String) {
    core::note_unlock_success(&state.data_dir, &account)
}

#[tauri::command]
fn forget_device(state: State<'_, AppState>, account: String) -> Result<(), String> {
    core::forget_device_secret(&state.data_dir, &account)
}

#[tauri::command]
fn secure_random_hex(length: usize) -> Result<String, String> {
    if length == 0 || length > 1024 {
        return Err("length must be between 1 and 1024".into());
    }
    core::random_hex(length)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the existing window instead of starting a
        // second copy with its own view of the same vault.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("the platform must provide an application data directory");
            std::fs::create_dir_all(&data_dir).ok();
            app.manage(AppState { data_dir });

            // Developer tools are a debug-build affordance. Shipping them in a
            // messenger would hand any social-engineering attack a console.
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            // A note on calls, because it is the one place the two desktop
            // platforms differ and it is better said than discovered:
            //
            //   Windows (WebView2) prompts the user for microphone and camera
            //   the same way a browser does, and calls work out of the box.
            //
            //   Linux (WebKitGTK) routes the permission request to the host
            //   application instead, and Tauri does not expose a hook for it,
            //   so the request is denied by default. Until it does, a Linux
            //   user who needs calls can open the same web client in a browser
            //   — the server and the protocol are identical. docs/DEPLOY.md
            //   says so, rather than leaving it to be found out mid-call.
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core_info,
            device_secret,
            unlock_delay,
            note_unlock_failure,
            note_unlock_success,
            forget_device,
            secure_random_hex
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the Kivora desktop shell");
}
