//! Spotify transport control via the local macOS Spotify desktop app.
//!
//! The webview can't run AppleScript, so these Tauri commands shell out to
//! `osascript`. macOS-only; non-macOS targets get fallbacks that report the
//! player as unavailable so the app still builds and the UI degrades cleanly.

use serde::Serialize;

#[derive(Serialize)]
pub struct SpotifyState {
    /// "playing" | "paused" | "stopped" | "unavailable"
    status: String,
    track: Option<String>,
    artist: Option<String>,
}

impl SpotifyState {
    fn unavailable() -> Self {
        SpotifyState {
            status: "unavailable".into(),
            track: None,
            artist: None,
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::SpotifyState;
    use std::process::Command;

    fn run_osascript(script: &str) -> Result<String, String> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    /// Whether the Spotify app is running. Uses `is running`, which does NOT
    /// launch Spotify and does NOT trigger the Apple Events permission prompt
    /// (only the actual `tell` commands below do, once, for Spotify).
    fn spotify_running() -> bool {
        run_osascript(r#"application "Spotify" is running"#)
            .map(|s| s == "true")
            .unwrap_or(false)
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
        run_osascript(&format!(r#"tell application "Spotify" to {cmd}"#))?;
        Ok(())
    }

    pub fn state() -> SpotifyState {
        if !spotify_running() {
            return SpotifyState::unavailable();
        }
        // Returns three linefeed-separated fields: state, track, artist.
        let script = r#"tell application "Spotify"
  set st to player state as string
  if st is "stopped" then
    return "stopped" & linefeed & "" & linefeed & ""
  end if
  return st & linefeed & (name of current track) & linefeed & (artist of current track)
end tell"#;
        match run_osascript(script) {
            Ok(out) => {
                let mut lines = out.splitn(3, '\n');
                let raw_status = lines.next().unwrap_or("").trim().to_string();
                let track = lines
                    .next()
                    .map(str::to_string)
                    .filter(|s| !s.is_empty());
                let artist = lines
                    .next()
                    .map(str::to_string)
                    .filter(|s| !s.is_empty());
                let status = match raw_status.as_str() {
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
            Err(_) => SpotifyState::unavailable(),
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
    SpotifyState::unavailable()
}
