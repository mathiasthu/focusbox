mod spotify;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Single-instance MUST be the first plugin registered. Desktop-only: a second launch
    // (the reported Windows "the app opens multiple times" bug) is routed into the already-
    // running instance, which just reveals + focuses the existing window instead of
    // spawning another process.
    #[cfg(desktop)]
    {
        use tauri::Manager;
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init());

    // Window-state: desktop-only. Restores the last window position/size on
    // launch and saves it as the window moves/resizes/closes.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    // Auto-updater: desktop-only (check on launch, sign-verified, prompt-to-restart).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // Launch at login: desktop-only, and OFF until the user turns it on in Settings —
    // registering the plugin only makes the enable/disable/is-enabled commands available,
    // it doesn't register the app with the OS. macOS uses a LaunchAgent plist (works
    // wherever the .app lives, unlike the AppleScript login-items route); Windows uses
    // the HKCU Run key. No extra launch args: a boot launch is an ordinary launch.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    builder
        .invoke_handler(tauri::generate_handler![
            spotify::spotify_control,
            spotify::spotify_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
