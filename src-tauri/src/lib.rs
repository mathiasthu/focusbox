mod appstore;
mod focusguard;
mod spotify;
mod todoist;

/// Every app command, in one place so the ACL test below exercises the same list `run()`
/// registers. Each one must also be listed in build.rs and granted in capabilities/*.json.
macro_rules! app_commands {
    () => {
        tauri::generate_handler![
            crate::spotify::spotify_control,
            crate::spotify::spotify_state,
            crate::appstore::app_store_read,
            crate::appstore::app_store_write,
            crate::focusguard::guard_supported,
            crate::focusguard::guard_set_config,
            crate::focusguard::get_nudge_state,
            crate::focusguard::nudge_resolve,
            crate::focusguard::guard_log_newtask,
            crate::focusguard::guard_stats,
            crate::todoist::todoist_status,
            crate::todoist::todoist_set_token,
            crate::todoist::todoist_clear_token,
            crate::todoist::park
        ]
    };
}

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
        .manage(appstore::StoreLock::default())
        .manage(std::sync::Arc::new(focusguard::GuardState::default()))
        .manage(std::sync::Arc::new(todoist::Todoist::default()));

    // Window-state: desktop-only. Restores the last window position/size on
    // launch and saves it as the window moves/resizes/closes.
    // The focus-guard nudge positions itself over the current monitor every time it opens,
    // so it must not get a remembered position/size restored on top of that.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_denylist(&[focusguard::NUDGE_LABEL])
            .build(),
    );

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
        .setup(|app| {
            focusguard::init(app.handle());
            todoist::init(app.handle());
            Ok(())
        })
        .invoke_handler(app_commands!())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod acl_tests {
    //! The app commands are behind the ACL now (see build.rs). A command missing from a
    //! capability fails only at runtime, as "not allowed by ACL", so pin the grants here
    //! against the real generated context.
    use std::sync::Arc;
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};

    fn call(w: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str) -> Result<serde_json::Value, String> {
        let res = get_ipc_response(
            w,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }
                    .parse()
                    .unwrap(),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        res.map(|b| b.deserialize::<serde_json::Value>().unwrap()).map_err(|e| e.to_string())
    }

    #[test]
    fn main_and_nudge_windows_get_exactly_their_commands() {
        let app = mock_builder()
            .manage(crate::appstore::StoreLock::default())
            .manage(Arc::new(crate::focusguard::GuardState::default()))
            .manage(Arc::new(crate::todoist::Todoist::default()))
            .invoke_handler(app_commands!())
            // `test = true` skips the Info.plist embed, which run()'s context already did.
            .build(tauri::generate_context!(test = true))
            .expect("build mock app");
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let nudge = tauri::WebviewWindowBuilder::new(&app, "nudge", Default::default()).build().unwrap();

        let denied = |r: Result<serde_json::Value, String>| matches!(r, Err(e) if e.contains("not allowed"));

        // Main: its commands go through. Only commands with required arguments are called
        // with an empty body, so they stop at argument parsing (an error that is not an ACL
        // denial) and nothing touches the real store, Keychain or Spotify.
        assert!(call(&main, "guard_supported").is_ok());
        for cmd in [
            "spotify_control",
            "app_store_write",
            "guard_set_config",
            "guard_log_newtask",
            "guard_stats",
            "todoist_set_token",
            "park",
        ] {
            let r = call(&main, cmd);
            assert!(r.is_err() && !denied(r.clone()), "main must reach {cmd}: {r:?}");
        }
        // The nudge-only commands are refused to main.
        assert!(denied(call(&main, "get_nudge_state")));
        assert!(denied(call(&main, "nudge_resolve")));

        // Nudge: its payload, nothing else.
        assert_eq!(call(&nudge, "get_nudge_state"), Ok(serde_json::Value::Null));
        for cmd in [
            "app_store_read",
            "app_store_write",
            "guard_set_config",
            "guard_stats",
            "todoist_status",
            "todoist_set_token",
            "todoist_clear_token",
            "park",
            "spotify_state",
            "guard_supported",
            "guard_log_newtask",
        ] {
            assert!(denied(call(&nudge, cmd)), "nudge must not reach {cmd}");
        }
    }
}
