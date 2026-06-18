//! Spotify transport control via the local macOS Spotify desktop app.
//!
//! The webview can't run AppleScript, so these Tauri commands shell out to
//! `osascript`. macOS-only; non-macOS targets get fallbacks that report the
//! player as unavailable so the app still builds and the UI degrades cleanly.
//!
//! Running-detection deliberately uses `pgrep` rather than AppleScript: reading
//! `application "Spotify" is running` involves the app's Apple-event permission,
//! which (for this ad-hoc-signed app) can be denied *before* any prompt appears
//! — leaving the player stuck. `pgrep` needs no permission and never launches
//! Spotify, so the FIRST real Apple event is the control/state command below,
//! which is what surfaces the one-time macOS Automation prompt.

use serde::Serialize;

#[derive(Serialize)]
pub struct SpotifyState {
    /// "playing" | "paused" | "stopped" | "denied" | "unavailable"
    status: String,
    track: Option<String>,
    artist: Option<String>,
}

impl SpotifyState {
    fn simple(status: &str) -> Self {
        SpotifyState {
            status: status.into(),
            track: None,
            artist: None,
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::SpotifyState;
    use std::process::Command;

    const OSASCRIPT: &str = "/usr/bin/osascript";
    const PGREP: &str = "/usr/bin/pgrep";

    fn run_osascript(script: &str) -> Result<String, String> {
        let output = Command::new(OSASCRIPT)
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("spawn osascript failed: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    /// Permission-free running check: no Apple events, never launches Spotify.
    /// `-x` matches the exact process name "Spotify" (excludes "Spotify Helper").
    fn spotify_running() -> bool {
        Command::new(PGREP)
            .arg("-x")
            .arg("Spotify")
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false)
    }

    /// macOS reports a refused Apple event as errAEEventNotPermitted (-1743),
    /// "Not authorized to send Apple events to Spotify".
    fn is_not_authorized(err: &str) -> bool {
        err.contains("-1743") || err.contains("Not authori")
    }

    pub fn control(action: &str) -> Result<(), String> {
        let cmd = match action {
            "playpause" => "playpause",
            "next" => "next track",
            "previous" => "previous track",
            other => return Err(format!("unknown action: {other}")),
        };
        if !spotify_running() {
            return Err("Spotify is not running".into());
        }
        run_osascript(&format!(r#"tell application "Spotify" to {cmd}"#)).map(|_| ())
    }

    fn parse_state(out: &str) -> SpotifyState {
        let mut lines = out.splitn(3, '\n');
        let raw = lines.next().unwrap_or("").trim();
        let track = lines.next().map(str::to_string).filter(|s| !s.is_empty());
        let artist = lines.next().map(str::to_string).filter(|s| !s.is_empty());
        let status = match raw {
            "playing" => "playing",
            "paused" => "paused",
            _ => "stopped",
        };
        SpotifyState {
            status: status.into(),
            track,
            artist,
        }
    }

    pub fn state() -> SpotifyState {
        if !spotify_running() {
            return SpotifyState::simple("unavailable");
        }
        // One-liner in the `to` form. The block/`set` form hits an osascript
        // parser quirk on recent macOS (a bare two-letter variable like `st` is
        // misread → -2741), so we avoid it entirely. Returns status, track and
        // artist on three lines. This is the first real Apple event, so it also
        // surfaces the one-time Automation permission prompt.
        let combined = r#"tell application "Spotify" to (player state as string) & linefeed & (name of current track) & linefeed & (artist of current track)"#;
        match run_osascript(combined) {
            Ok(out) => parse_state(&out),
            Err(e) if is_not_authorized(&e) => {
                eprintln!("[focusbox] Spotify Apple events not authorized: {e}");
                SpotifyState::simple("denied")
            }
            Err(_) => {
                // Most likely stopped with no current track to name — fall back
                // to just the player state.
                match run_osascript(r#"tell application "Spotify" to player state as string"#) {
                    Ok(s) if s == "playing" || s == "paused" => SpotifyState::simple(&s),
                    Ok(_) => SpotifyState::simple("stopped"),
                    Err(e) if is_not_authorized(&e) => {
                        eprintln!("[focusbox] Spotify Apple events not authorized: {e}");
                        SpotifyState::simple("denied")
                    }
                    Err(e) => {
                        eprintln!("[focusbox] spotify_state error: {e}");
                        SpotifyState::simple("unavailable")
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn spotify_control(action: String) -> Result<(), String> {
    imp::control(&action)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn spotify_state() -> SpotifyState {
    imp::state()
}

// ---- Non-macOS fallbacks (Windows/Linux) so the app still builds ----

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn spotify_control(_action: String) -> Result<(), String> {
    Err("Spotify control is only available on macOS".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn spotify_state() -> SpotifyState {
    SpotifyState::simple("unavailable")
}
