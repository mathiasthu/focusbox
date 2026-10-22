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
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const OSASCRIPT: &str = "/usr/bin/osascript";
    const PGREP: &str = "/usr/bin/pgrep";
    /// A Spotify that stops answering Apple events leaves osascript waiting forever
    /// (seen 2026-10-22: one call hung for two hours), so give up after this. Long
    /// enough to answer the first-run Automation prompt, which osascript waits on.
    const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(20);

    fn run_osascript(script: &str) -> Result<String, String> {
        run_osascript_within(script, OSASCRIPT_TIMEOUT)
    }

    /// Err holds osascript's error text, or "timeout" if it was killed for running
    /// past `timeout`.
    fn run_osascript_within(script: &str, timeout: Duration) -> Result<String, String> {
        let mut child = Command::new(OSASCRIPT)
            .arg("-e")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn osascript failed: {e}"))?;
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut out = String::new();
                    let mut err = String::new();
                    if let Some(mut o) = child.stdout.take() {
                        let _ = o.read_to_string(&mut out);
                    }
                    if let Some(mut e) = child.stderr.take() {
                        let _ = e.read_to_string(&mut err);
                    }
                    if !status.success() {
                        return Err(err.trim().to_string());
                    }
                    return Ok(out.trim().to_string());
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("timeout".into());
                }
            }
        }
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
            Err(e) if e == "timeout" => {
                // Spotify isn't answering; don't wait on it a second time.
                eprintln!("[focusbox] spotify_state: Spotify did not answer");
                SpotifyState::simple("unavailable")
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_hung_osascript_times_out() {
            let started = Instant::now();
            let res = run_osascript_within("delay 10", Duration::from_millis(300));
            assert_eq!(res, Err("timeout".to_string()));
            assert!(started.elapsed() < Duration::from_secs(3));
        }

        #[test]
        fn a_quick_osascript_returns_its_output() {
            let res = run_osascript_within(r#"return "ok""#, Duration::from_secs(10));
            assert_eq!(res, Ok("ok".to_string()));
        }
    }
}

// Async so Tauri runs them off the main thread: a plain (sync) command runs on the UI
// thread, and a slow osascript call there froze the whole window.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn spotify_control(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || imp::control(&action))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn spotify_state() -> SpotifyState {
    tauri::async_runtime::spawn_blocking(imp::state)
        .await
        .unwrap_or_else(|_| SpotifyState::simple("unavailable"))
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
