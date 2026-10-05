//! The "Parked in Todoist" confirmation: a small click-through pill at the top centre of the
//! screen, shown after every park (drift nudge and the main window's new-task prompt).
//!
//! It must never take focus: the user is usually on their way back to the task. So the
//! window is built unfocused, Focusbox is not activated, and it ignores the cursor. Rust
//! owns its lifetime: it holds the payload, and destroys the window once the payload's
//! time is up unless a newer park replaced it (which restarts the clock).
//!
//! The window (label "toast", `index.html?view=toast`) can call exactly one command,
//! `get_toast_state` (capabilities/toast.json).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

pub const TOAST_LABEL: &str = "toast";
const WIDTH: f64 = 340.0;
const HEIGHT: f64 = 64.0;
/// Below the menu bar.
const TOP_OFFSET: f64 = 70.0;
/// The page fades out over this long after `duration_ms`; the window goes after that.
const FADE_MS: u64 = 300;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToastPayload {
    /// Increments on every show, so the page can restart its timer on a replace.
    pub seq: u64,
    /// The park result: "sent" | "queued" | "no_token" | "auth_blocked" | "rejected".
    /// The page turns it into words (focusGuard.ts toastCopy).
    pub result: String,
    pub text: String,
    /// How long it stays fully visible before fading.
    pub duration_ms: u64,
}

pub fn duration_for(result: &str) -> u64 {
    if result == "sent" {
        2_500
    } else {
        3_500
    }
}

#[derive(Default)]
struct Inner {
    seq: u64,
    payload: Option<ToastPayload>,
}

#[derive(Default)]
pub struct ToastState {
    inner: Mutex<Inner>,
}

impl ToastState {
    /// Replace whatever is showing. Returns the new payload.
    pub fn show(&self, result: &str, text: &str) -> Option<ToastPayload> {
        let mut i = self.inner.lock().ok()?;
        i.seq += 1;
        let p = ToastPayload {
            seq: i.seq,
            result: result.to_string(),
            text: text.trim().chars().take(200).collect(),
            duration_ms: duration_for(result),
        };
        i.payload = Some(p.clone());
        Some(p)
    }

    pub fn current(&self) -> Option<ToastPayload> {
        self.inner.lock().ok().and_then(|i| i.payload.clone())
    }

    /// Time's up for `seq`: true (and the payload is cleared) only if nothing replaced it.
    pub fn expire(&self, seq: u64) -> bool {
        let Ok(mut i) = self.inner.lock() else { return false };
        if i.payload.as_ref().map(|p| p.seq) != Some(seq) {
            return false;
        }
        i.payload = None;
        true
    }
}

/// One step for the toast window. Like the nudge, it is created once and then only shown
/// and hidden, never destroyed (destroying a WKWebView with a display-link refresh pending
/// crashed WebKit; see `focusguard::WinOp`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastOp {
    /// Build it hidden, already placed.
    Create,
    /// Move it to the anchor monitor (only ever while hidden).
    Place,
    /// Page re-fetches the payload and restarts its fade timer.
    Refresh,
    /// Order front without focus or activation.
    ShowQuietly,
}

/// Steps to show (or replace) the toast.
pub fn plan_toast_present(exists: bool, visible: bool) -> Vec<ToastOp> {
    use ToastOp::*;
    match (exists, visible) {
        (false, _) => vec![Create, ShowQuietly],
        // Already up: replace the text where it is; never move a window on screen.
        (true, true) => vec![Refresh],
        (true, false) => vec![Place, Refresh, ShowQuietly],
    }
}

/// Show (or replace) the toast. Never focuses anything.
///
/// It goes on the monitor of the window labelled `anchor`, resolved now: the nudge is
/// hidden right after a park from it, so by the time the toast is placed it may be gone.
pub fn show_toast<R: Runtime>(app: &AppHandle<R>, result: &str, text: &str, anchor: &str) {
    let state = app.state::<Arc<ToastState>>().inner().clone();
    let Some(payload) = state.show(result, text) else { return };
    let monitor = app.get_webview_window(anchor).and_then(|w| w.current_monitor().ok().flatten());
    present(app, monitor);
    // Expiry: the page fades itself out at duration_ms; the window is hidden (kept for
    // reuse) a moment later, unless a newer park replaced this one.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(payload.duration_ms + FADE_MS + 100));
        if state.expire(payload.seq) {
            let app3 = app2.clone();
            let _ = app2.run_on_main_thread(move || {
                if let Some(w) = app3.get_webview_window(TOAST_LABEL) {
                    let _ = w.hide();
                }
            });
        }
    });
}

fn present<R: Runtime>(app: &AppHandle<R>, monitor: Option<tauri::Monitor>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let app = handle;
        // The anchor window's monitor, else the cursor's, else the primary.
        let monitor = monitor
            .or_else(|| {
                app.cursor_position()
                    .ok()
                    .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
            })
            .or_else(|| app.primary_monitor().ok().flatten());
        let mut w = app.get_webview_window(TOAST_LABEL);
        let visible = w.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false);
        for op in plan_toast_present(w.is_some(), visible) {
            match op {
                ToastOp::Create => w = build(&app, monitor.as_ref()),
                ToastOp::Place => {
                    if let (Some(w), Some(m)) = (&w, &monitor) {
                        let _ = w.set_position(toast_position(m));
                    }
                }
                ToastOp::Refresh => {
                    if let Some(w) = &w {
                        let _ = w.emit_to(TOAST_LABEL, "toast://refresh", ());
                    }
                }
                ToastOp::ShowQuietly => {
                    if let Some(w) = &w {
                        crate::focusguard::show_quietly(w);
                        crate::focusguard::raise_webview_window(w);
                    }
                }
            }
        }
    });
}

/// Top centre of `m`, below the menu bar (logical).
fn toast_position(m: &tauri::Monitor) -> tauri::LogicalPosition<f64> {
    let scale = m.scale_factor();
    let pos = m.position().to_logical::<f64>(scale);
    let size = m.size().to_logical::<f64>(scale);
    tauri::LogicalPosition::new(pos.x + (size.width - WIDTH) / 2.0, pos.y + TOP_OFFSET)
}

fn build<R: Runtime>(app: &AppHandle<R>, monitor: Option<&tauri::Monitor>) -> Option<tauri::WebviewWindow<R>> {
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        TOAST_LABEL,
        tauri::WebviewUrl::App("index.html?view=toast".into()),
    )
    .title("Focusbox")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(true)
    // Never steal focus: built hidden and unfocused; ToastOp::ShowQuietly orders it front
    // without making it key, and Focusbox is not activated anywhere on this path.
    .visible(false)
    .focused(false)
    .inner_size(WIDTH, HEIGHT);
    #[cfg(target_os = "macos")]
    {
        builder = builder.transparent(true);
    }
    if let Some(m) = monitor {
        let p = toast_position(m);
        builder = builder.position(p.x, p.y);
    } else {
        builder = builder.center();
    }
    match builder.build() {
        Ok(w) => {
            let _ = w.set_ignore_cursor_events(true);
            // Same level as the nudge (above the menu bar, over full-screen Spaces). This
            // orders nothing front and makes nothing key.
            crate::focusguard::raise_webview_window(&w);
            Some(w)
        }
        Err(e) => {
            eprintln!("Focusbox: could not create the park confirmation: {e}");
            None
        }
    }
}

/// The toast window's only command: what to show.
#[tauri::command]
pub fn get_toast_state(state: State<'_, Arc<ToastState>>) -> Option<ToastPayload> {
    state.current()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_park_replaces_the_toast_and_restarts_its_clock() {
        let s = ToastState::default();
        assert_eq!(s.current(), None);
        let a = s.show("sent", "  Reply to Anna  ").unwrap();
        assert_eq!(a.text, "Reply to Anna");
        assert_eq!(a.duration_ms, 2_500);
        let b = s.show("queued", "Read the RFC").unwrap();
        assert!(b.seq > a.seq);
        assert_eq!(b.duration_ms, 3_500);
        assert_eq!(s.current(), Some(b.clone()));
        assert!(!s.expire(a.seq), "the first toast's timer must not close the second");
        assert_eq!(s.current(), Some(b.clone()));
        assert!(s.expire(b.seq));
        assert_eq!(s.current(), None);
        assert!(!s.expire(b.seq), "expires once");
    }

    #[test]
    fn non_sent_results_stay_longer() {
        assert_eq!(duration_for("sent"), 2_500);
        for r in ["queued", "no_token", "auth_blocked", "rejected"] {
            assert_eq!(duration_for(r), 3_500);
        }
    }

    #[test]
    fn the_toast_window_is_created_once_then_shown_and_hidden() {
        use ToastOp::*;
        assert_eq!(plan_toast_present(false, false), vec![Create, ShowQuietly]);
        // Hidden from last time: moved (while hidden), refreshed, shown.
        assert_eq!(plan_toast_present(true, false), vec![Place, Refresh, ShowQuietly]);
        // Still up: a second park only replaces the text (and restarts its timer).
        assert_eq!(plan_toast_present(true, true), vec![Refresh]);
        for exists in [false, true] {
            for visible in [false, true] {
                let ops = plan_toast_present(exists, visible);
                assert_eq!(ops.contains(&Create), !exists);
                assert!(!(visible && ops.contains(&Place)), "never moved while on screen");
            }
        }
    }

    #[test]
    fn a_park_right_after_expiry_shows_again() {
        let s = ToastState::default();
        let a = s.show("sent", "x").unwrap();
        assert!(s.expire(a.seq));
        let b = s.show("queued", "y").unwrap();
        assert_eq!(s.current(), Some(b.clone()), "the hidden window gets the new payload");
        assert!(!s.expire(a.seq));
        assert!(s.expire(b.seq));
    }
}
