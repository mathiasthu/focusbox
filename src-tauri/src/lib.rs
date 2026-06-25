mod spotify;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
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
