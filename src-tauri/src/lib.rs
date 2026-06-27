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

    // Auto-updater: desktop-only (check on launch, sign-verified, prompt-to-restart).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .invoke_handler(tauri::generate_handler![
            spotify::spotify_control,
            spotify::spotify_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
