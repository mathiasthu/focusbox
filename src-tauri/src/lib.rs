mod appstore;
mod spotify;

/// Confine the webview to the app's own origin.
///
/// The Focusbox window is chromeless — no address bar, no back button, no visual cue that
/// the page changed — and the passphrase that unwraps everything is typed inside it. A
/// same-window navigation to a remote page is therefore a convincing "session expired,
/// re-enter your sync passphrase" capture. Tauri's default navigation handler allows every
/// navigation unconditionally, and a link only has to reach `window.open(href, "_self")`
/// to use it (an anchor pasted with `target="_self"` did exactly that).
///
/// The editor-side fixes in Notes.tsx stop the known route in; this stops the class. After
/// a navigation off-origin the webview is `Origin::Remote`, so the capability's
/// `ExecutionContext::Local` no longer matches and every app command is denied — but that
/// only limits the damage, it does not prevent the phishing page from rendering.
fn nav_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("focusbox-nav-guard")
        .on_navigation(|_webview, url| {
            let allowed = match url.scheme() {
                // The packaged app: `tauri://localhost` (macOS/Linux) or, on Windows,
                // `http://tauri.localhost`.
                "tauri" => true,
                "http" | "https" => match url.host_str() {
                    Some("tauri.localhost") => true,
                    // The Vite dev server. Never reachable in a shipped build.
                    Some("localhost") | Some("127.0.0.1") => cfg!(dev),
                    _ => false,
                },
                // WebKit navigates here internally while tearing a webview down.
                "about" => true,
                _ => false,
            };
            if !allowed {
                eprintln!("Focusbox: blocked navigation to {url}");
            }
            allowed
        })
        .build()
}

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
        .plugin(nav_guard())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .manage(appstore::StoreLock::default());

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
            spotify::spotify_state,
            appstore::app_store_read,
            appstore::app_store_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
