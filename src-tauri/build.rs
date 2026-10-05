// The app's own commands go through the ACL like plugin commands do. Without this manifest
// Tauri lets every local window call every app command, and there is now a second
// window (the focus-guard nudge) that should only reach the two commands it needs. Each
// name below gets `allow-<name>` / `deny-<name>` permissions generated (underscores become
// hyphens); capabilities/default.json grants the main window its set and
// capabilities/nudge.json grants the nudge its two.
//
// Adding a command: list it here AND in `generate_handler!` in lib.rs AND grant it in a
// capability, or calls to it fail at runtime with "not allowed by ACL".
const COMMANDS: &[&str] = &[
    "spotify_control",
    "spotify_state",
    "app_store_read",
    "app_store_write",
    "guard_supported",
    "guard_set_config",
    "get_nudge_state",
    "nudge_resolve",
    "guard_log_newtask",
    "guard_stats",
    "guard_preview_nudge",
    "todoist_status",
    "todoist_set_token",
    "todoist_clear_token",
    "park",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
