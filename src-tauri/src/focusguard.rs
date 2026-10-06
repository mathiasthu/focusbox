//! Focus guard: notices when the user drifts off the current Focus task and puts a
//! full-screen nudge in front of them.
//!
//! Why this lives in Rust and not in the main webview: the webview's timers are throttled
//! (or stopped outright) while its window is hidden or occluded, which is exactly when the
//! guard has to keep working. So the frontend only pushes *facts* (is the guard on, what is
//! the Focus task, is the timer running, the allow-list, the workday window) through
//! `guard_set_config`, and a plain OS thread here does the sampling and the counting.
//!
//! Layout of this file:
//! - pure logic, unit-tested, no clock and no OS: [`GuardConfig`], [`mode_for`],
//!   [`in_workday`], domain matching, and the drift state machine [`Machine`];
//! - the event log (JSONL in the app data dir) used for the stats view;
//! - the macOS platform layer (frontmost app via NSWorkspace, the active browser tab via
//!   `osascript`, re-activating an app, raising the nudge window), with no-op fallbacks so
//!   the Windows build compiles;
//! - the watcher thread, the nudge window, and the Tauri commands.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Focusbox's own bundle id. Always on-task: the nudge itself, Settings, the notes.
pub const SELF_BUNDLE_ID: &str = "com.mathiass.focusbox";

/// How often the watcher samples the frontmost app.
const TICK: Duration = Duration::from_secs(2);
/// Longest gap one sample may account for. A sleeping Mac or a stalled thread must not turn
/// into "off task for 40 minutes" the moment it wakes up.
const MAX_STEP_MS: u64 = 5_000;
/// Focused time is logged in whole minutes while on task (away time likewise).
const FOCUSED_CHUNK_MS: u64 = 60_000;
/// On task, no input still counts as focused (waiting on a build or an AI agent,
/// reading) for this long; past it the user is away.
const LONG_IDLE_MS: u64 = 15 * 60_000;
/// Minimum length of a typed reason (trimmed, in characters).
pub const MIN_REASON_CHARS: usize = 10;
/// Anything longer from the webview is cut, so the log can't be bloated from JS.
const MAX_TEXT_CHARS: usize = 500;
/// Log entries older than this are dropped on startup.
const LOG_RETENTION_MS: u64 = 90 * 24 * 60 * 60 * 1000;
const LOG_FILE: &str = "focusguard-log.jsonl";
/// The nudge window's label. Its capability (`capabilities/nudge.json`) is scoped to it.
pub const NUDGE_LABEL: &str = "nudge";

/// Browsers whose active tab address is read, and the AppleScript for each. The scripts are
/// constants keyed by bundle id: nothing from the webview or the frontmost app reaches them.
// Only the macOS platform layer reads these two; Windows has no watcher.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const BROWSERS: &[(&str, &str)] = &[
    (
        "com.google.Chrome",
        "tell application id \"com.google.Chrome\" to get URL of active tab of front window",
    ),
    (
        "company.thebrowser.Browser",
        "tell application id \"company.thebrowser.Browser\" to get URL of active tab of front window",
    ),
    (
        "com.apple.Safari",
        "tell application id \"com.apple.Safari\" to get URL of current tab of front window",
    ),
];

/// Every tab's URL in every window of a browser, for finding a video call in any tab (not
/// only the front one). Only ever sent to a browser that is already running, so it never
/// launches one. osascript prints the nested list flattened as "url, url, url".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const ALL_TABS_SCRIPTS: &[(&str, &str)] = &[
    ("com.google.Chrome", "tell application id \"com.google.Chrome\" to get URL of tabs of windows"),
    (
        "company.thebrowser.Browser",
        "tell application id \"company.thebrowser.Browser\" to get URL of tabs of windows",
    ),
    ("com.apple.Safari", "tell application id \"com.apple.Safari\" to get URL of tabs of windows"),
];

/// Zoom starts this helper for the length of a meeting (it hosts the call's capture) and
/// quits it when the meeting ends, so its presence means "in a Zoom meeting".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const ZOOM_MEETING_PROCESS: &str = "CptHost";

/// A browser tab that is a video call: a Google Meet room (meet.google.com/abc-defg-hij,
/// not the Meet home page) or the Zoom web client (zoom.us/wc/...).
pub fn is_meeting_url(raw: &str) -> bool {
    let Ok(u) = url::Url::parse(raw.trim()) else { return false };
    if u.scheme() != "https" && u.scheme() != "http" {
        return false;
    }
    let Some(host) = u.host_str() else { return false };
    let first = u.path().trim_start_matches('/').split('/').next().unwrap_or("");
    if host_matches(host, "meet.google.com") {
        let parts: Vec<&str> = first.split('-').collect();
        let lens: Vec<usize> = parts.iter().map(|p| p.len()).collect();
        return lens == [3, 4, 3] && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_lowercase()));
    }
    host_matches(host, "zoom.us") && first == "wc"
}

/// Frontmost while the screen is locked or the screen saver runs: time away, not drift.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const AWAY_BUNDLES: &[&str] = &["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"];

// ---------------------------------------------------------------------------------------
// Configuration pushed from the main window
// ---------------------------------------------------------------------------------------

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TimerState {
    Running,
    Paused,
    #[default]
    Idle,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Workday {
    pub enabled: bool,
    /// "HH:MM", local to `tz`.
    pub start: String,
    pub end: String,
    /// ISO weekdays, 1 = Monday … 7 = Sunday.
    pub days: Vec<u32>,
    /// IANA zone name, e.g. "Asia/Bangkok". Unknown names fall back to the system zone.
    pub tz: String,
}

impl Default for Workday {
    fn default() -> Self {
        Workday {
            enabled: false,
            start: "10:00".into(),
            end: "19:00".into(),
            days: vec![1, 2, 3, 4, 5, 6],
            tz: "Asia/Bangkok".into(),
        }
    }
}

/// What the main window knows and the watcher needs. Rust derives the guard's mode from
/// this plus the clock, rather than the frontend sending an "active" flag, because the
/// workday window opens and closes on its own while the webview may be throttled.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GuardConfig {
    pub enabled: bool,
    /// A Focus card exists and is not done.
    pub has_task: bool,
    pub task_text: String,
    /// Normalized task text; a change starts a new task session (drift count resets).
    pub task_key: String,
    pub timer: TimerState,
    /// Bundle ids. Focusbox itself is always allowed and need not be listed.
    pub allow_apps: Vec<String>,
    /// Host suffixes: "github.com" also matches "gist.github.com".
    pub allow_domains: Vec<String>,
    pub grace_secs: u64,
    pub workday: Workday,
    /// Native blur (NSVisualEffectView) behind the translucent nudge. Applied when the
    /// nudge window is created; a change while one is open takes effect on the next one.
    pub blur: bool,
    /// No hardware input for this long (and no video in the app in front) = away.
    pub idle_after_secs: u64,
    /// "Pause guard" from Settings or the tray: epoch ms. Until then the guard is idle (no
    /// sampling, nudges or logging); it resumes by itself once this passes. 0 = not paused.
    pub paused_until: u64,
}

impl Default for GuardConfig {
    fn default() -> Self {
        GuardConfig {
            enabled: false,
            has_task: false,
            task_text: String::new(),
            task_key: String::new(),
            timer: TimerState::Idle,
            allow_apps: Vec::new(),
            allow_domains: Vec::new(),
            grace_secs: 30,
            workday: Workday::default(),
            blur: false,
            idle_after_secs: 180,
            paused_until: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Nothing to watch.
    Idle,
    /// A task is active: count off-task time.
    Guard,
}

/// The guard's mode for a config and whether "now" is inside the workday window.
///
/// - Off: idle.
/// - A Focus task with the timer running: guard.
/// - Inside the workday window: a Focus task with the timer paused is still guarded.
/// - Anything else is idle. In particular there is no prompt when no task or no timer is
///   running: the owner asked for no on-screen "start a task" nagging (2026-10-05). A Focus
///   card with an idle timer gets a quiet in-app reminder in the main window instead
///   (src/lib/timerPrompt.ts).
pub fn mode_for(cfg: &GuardConfig, in_window: bool) -> Mode {
    if !cfg.enabled {
        return Mode::Idle;
    }
    if cfg.has_task && cfg.timer == TimerState::Running {
        return Mode::Guard;
    }
    if cfg.workday.enabled && in_window && cfg.has_task && cfg.timer == TimerState::Paused {
        return Mode::Guard;
    }
    Mode::Idle
}

/// `mode_for`, with "Pause guard" applied: while `now_epoch_ms < paused_until` the guard is
/// idle. Evaluated every tick, so it resumes by itself.
pub fn effective_mode(cfg: &GuardConfig, in_window: bool, now_epoch_ms: u64) -> Mode {
    if now_epoch_ms < cfg.paused_until {
        Mode::Idle
    } else {
        mode_for(cfg, in_window)
    }
}

/// A new pause starting (or an existing one being extended) with this config push.
/// Returns its length in seconds from now, for the log.
pub fn pause_started(old_until: u64, new_until: u64, now_epoch_ms: u64) -> Option<u64> {
    (new_until > now_epoch_ms && new_until > old_until.max(now_epoch_ms))
        .then(|| (new_until - now_epoch_ms) / 1000)
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let h: u32 = h.trim().parse().ok()?;
    let m: u32 = m.trim().parse().ok()?;
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Whether `now` falls inside the workday window, evaluated in the window's own zone.
/// An end earlier than the start is an overnight window; equal start and end is empty.
pub fn in_workday(w: &Workday, now: DateTime<Utc>) -> bool {
    if !w.enabled {
        return false;
    }
    let (Some(start), Some(end)) = (parse_hhmm(&w.start), parse_hhmm(&w.end)) else {
        return false;
    };
    let (weekday, minute) = match w.tz.trim().parse::<chrono_tz::Tz>() {
        Ok(tz) => {
            let t = now.with_timezone(&tz);
            (t.weekday().number_from_monday(), t.hour() * 60 + t.minute())
        }
        Err(_) => {
            let t = now.with_timezone(&chrono::Local);
            (t.weekday().number_from_monday(), t.hour() * 60 + t.minute())
        }
    };
    if !w.days.contains(&weekday) {
        return false;
    }
    if start < end {
        minute >= start && minute < end
    } else if start > end {
        minute >= start || minute < end
    } else {
        false
    }
}

// ---------------------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------------------

/// Reduce a user-typed site ("https://www.GitHub.com/foo", "*.notion.so") to a bare host
/// suffix ("github.com", "notion.so"). None if nothing host-like is left.
pub fn normalize_domain(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_ascii_lowercase();
    if let Some(i) = s.find("://") {
        s = s[i + 3..].to_string();
    }
    if let Some(i) = s.find(|c| matches!(c, '/' | '?' | '#')) {
        s.truncate(i);
    }
    if let Some(i) = s.rfind('@') {
        s = s[i + 1..].to_string();
    }
    if let Some(i) = s.find(':') {
        s.truncate(i);
    }
    let s = s.trim_start_matches("*.").trim_start_matches("www.").trim_matches('.');
    if s.is_empty() || !s.contains('.') || s.contains(char::is_whitespace) {
        return None;
    }
    Some(s.to_string())
}

/// Host-suffix match on label boundaries: "github.com" matches "github.com" and
/// "gist.github.com" but not "notgithub.com".
pub fn host_matches(host: &str, pattern: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let Some(p) = normalize_domain(pattern) else {
        return false;
    };
    host == p || host.ends_with(&format!(".{p}"))
}

/// The host of an http(s) URL, lowercased. Anything else (chrome://newtab, file://,
/// about:blank, garbage) has no domain.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn url_host(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let h = u.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    (!h.is_empty()).then_some(h)
}

// ---------------------------------------------------------------------------------------
// The drift state machine (pure)
// ---------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct FrontApp {
    pub bundle_id: Option<String>,
    pub name: String,
    /// Active tab host, only for a supported browser whose tab could be read.
    pub domain: Option<String>,
    /// The frontmost process is this one (covers the dev build, which has no bundle id).
    pub is_self: bool,
    /// Seconds since the last real (HID) keyboard/mouse/trackpad input.
    pub idle_secs: u64,
    /// The app in front holds a display-sleep assertion (a video playing). Only looked
    /// up once `idle_secs` reaches the idle threshold; false otherwise.
    pub video: bool,
    /// Process id of the frontmost app (0 if unknown). Used to put the nudge on the
    /// monitor of the window the user is actually working in.
    pub pid: i32,
}

impl FrontApp {
    /// What the nudge calls it: the site if known, else the app.
    pub fn label(&self) -> String {
        self.domain.clone().unwrap_or_else(|| self.name.clone())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sample {
    /// Screen locked / screen saver / nothing frontmost: neither on nor off task.
    Away,
    /// In a Zoom or Google Meet call. The guard stands down completely: any nudge on
    /// screen closes and nothing counts as off task.
    Meeting,
    Front(FrontApp),
}

/// A rectangle in macOS global display coordinates: points, origin at the top-left of the
/// primary display, y growing down (what CGWindowBounds and CGDisplayBounds use).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn overlap(&self, o: &Rect) -> f64 {
        let w = (self.x + self.w).min(o.x + o.w) - self.x.max(o.x);
        let h = (self.y + self.h).min(o.y + o.h) - self.y.max(o.y);
        if w > 0.0 && h > 0.0 {
            w * h
        } else {
            0.0
        }
    }
}

/// A Tauri monitor (physical position and size) as a Rect in global points. On macOS, tao
/// derives the physical position as CGDisplayBounds.origin × the monitor's own scale
/// factor, and the size as the display's point size × that scale, so dividing by the
/// monitor's own scale recovers CG points even with mixed-DPI displays.
pub fn monitor_points(pos: (i32, i32), size: (u32, u32), scale: f64) -> Rect {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    Rect { x: pos.0 as f64 / s, y: pos.1 as f64 / s, w: size.0 as f64 / s, h: size.1 as f64 / s }
}

/// The monitor a window belongs to: the one containing its centre, else the one it
/// overlaps most. None when it is on none of them (the caller falls back).
pub fn pick_monitor(win: Rect, monitors: &[Rect]) -> Option<usize> {
    let (cx, cy) = (win.x + win.w / 2.0, win.y + win.h / 2.0);
    if let Some(i) = monitors
        .iter()
        .position(|m| cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h)
    {
        return Some(i);
    }
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| (i, win.overlap(m)))
        .filter(|(_, a)| *a > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

/// Whether the user counts as away from this sample.
/// - Off task: no input for the idle threshold, unless the app in front plays video
///   (watching YouTube passively is drift, not absence).
/// - On task: quiet time is still work (waiting on an agent, reading) up to
///   LONG_IDLE_MS; past that, away.
pub fn is_away(cfg: &GuardConfig, app: &FrontApp, on_task: bool) -> bool {
    let idle_ms = app.idle_secs.saturating_mul(1000);
    if on_task {
        idle_ms >= LONG_IDLE_MS
    } else {
        idle_ms >= cfg.idle_after_secs.max(1).saturating_mul(1000) && !app.video
    }
}

pub fn is_on_task(cfg: &GuardConfig, app: &FrontApp) -> bool {
    if app.is_self {
        return true;
    }
    if let Some(b) = &app.bundle_id {
        if b.eq_ignore_ascii_case(SELF_BUNDLE_ID)
            || cfg.allow_apps.iter().any(|a| a.trim().eq_ignore_ascii_case(b))
        {
            return true;
        }
    }
    match &app.domain {
        Some(host) => cfg.allow_domains.iter().any(|p| host_matches(host, p)),
        None => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NudgeKind {
    Drift { app: FrontApp, count: u32 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    OpenNudge(NudgeKind),
    CloseNudge,
    /// Seconds of on-task time to log against `task`.
    Focused { task: String, secs: u64 },
    /// Seconds the user was away (idle or locked) while the guard was active.
    Away { task: String, secs: u64 },
}

#[derive(Debug)]
pub struct Machine {
    mode: Mode,
    last_ms: Option<u64>,
    task_key: String,
    task_text: String,
    off_ms: u64,
    focused_ms: u64,
    drift_count: u32,
    last_on_task_bundle: Option<String>,
    nudge: Option<NudgeKind>,
    away_ms: u64,
}

impl Default for Machine {
    fn default() -> Self {
        Machine {
            mode: Mode::Idle,
            last_ms: None,
            task_key: String::new(),
            task_text: String::new(),
            off_ms: 0,
            focused_ms: 0,
            drift_count: 0,
            last_on_task_bundle: None,
            nudge: None,
            away_ms: 0,
        }
    }
}

impl Machine {
    pub fn nudge(&self) -> Option<&NudgeKind> {
        self.nudge.as_ref()
    }
    #[cfg(test)]
    pub fn drift_count(&self) -> u32 {
        self.drift_count
    }
    pub fn last_on_task_bundle(&self) -> Option<&str> {
        self.last_on_task_bundle.as_deref()
    }

    fn flush_focused(&mut self, out: &mut Vec<Action>) {
        let secs = self.focused_ms / 1000;
        self.focused_ms = 0;
        if secs > 0 && !self.task_text.is_empty() {
            out.push(Action::Focused { task: self.task_text.clone(), secs });
        }
    }

    fn flush_away(&mut self, out: &mut Vec<Action>) {
        let secs = self.away_ms / 1000;
        self.away_ms = 0;
        if secs > 0 {
            out.push(Action::Away { task: self.task_text.clone(), secs });
        }
    }

    fn add_away(&mut self, dt: u64, out: &mut Vec<Action>) {
        self.away_ms += dt;
        while self.away_ms >= FOCUSED_CHUNK_MS {
            self.away_ms -= FOCUSED_CHUNK_MS;
            out.push(Action::Away { task: self.task_text.clone(), secs: FOCUSED_CHUNK_MS / 1000 });
        }
    }

    /// Advance by one sample taken at monotonic time `now_ms`. `sample` is None when the
    /// caller skipped sampling (idle mode).
    pub fn step(
        &mut self,
        cfg: &GuardConfig,
        mode: Mode,
        sample: Option<&Sample>,
        now_ms: u64,
    ) -> Vec<Action> {
        let mut out = Vec::new();
        let dt = self
            .last_ms
            .map(|l| now_ms.saturating_sub(l).min(MAX_STEP_MS))
            .unwrap_or(0);
        self.last_ms = Some(now_ms);

        // A different task is a new task session.
        if cfg.task_key != self.task_key {
            self.flush_focused(&mut out);
            self.flush_away(&mut out);
            self.task_key = cfg.task_key.clone();
            self.drift_count = 0;
            self.off_ms = 0;
            self.last_on_task_bundle = None;
            if matches!(self.nudge, Some(NudgeKind::Drift { .. })) {
                self.nudge = None;
                out.push(Action::CloseNudge);
            }
        }
        self.task_text = cfg.task_text.clone();

        if mode != self.mode {
            if self.mode == Mode::Guard {
                self.flush_focused(&mut out);
            }
            self.flush_away(&mut out);
            let keep = matches!((&self.nudge, mode), (Some(NudgeKind::Drift { .. }), Mode::Guard));
            if self.nudge.is_some() && !keep {
                self.nudge = None;
                out.push(Action::CloseNudge);
            }
            self.off_ms = 0;
            self.mode = mode;
        }

        match (mode, sample) {
            (Mode::Idle, _) | (_, None) => {}
            // In a call: never nudge, whatever is in front. A nudge already up goes away,
            // and the grace period starts fresh once the call ends.
            (_, Some(Sample::Meeting)) => {
                if self.nudge.take().is_some() {
                    out.push(Action::CloseNudge);
                }
                self.off_ms = 0;
            }
            // Locked / screen saver: away. Counters pause; nothing resets.
            (_, Some(Sample::Away)) => {
                if self.nudge.is_none() {
                    self.add_away(dt, &mut out);
                }
            }
            (Mode::Guard, Some(Sample::Front(app))) => {
                // Frozen while a nudge is up: it is resolved by the user, not by time, and
                // walking away doesn't close it either.
                if self.nudge.is_some() {
                    return out;
                }
                let on_task = is_on_task(cfg, app);
                if is_away(cfg, app, on_task) {
                    // Paused, not reset: the off-task count resumes where it was.
                    self.add_away(dt, &mut out);
                    return out;
                }
                if on_task {
                    self.off_ms = 0;
                    if !app.is_self {
                        if let Some(b) = &app.bundle_id {
                            if !b.eq_ignore_ascii_case(SELF_BUNDLE_ID) {
                                self.last_on_task_bundle = Some(b.clone());
                            }
                        }
                    }
                    self.focused_ms += dt;
                    while self.focused_ms >= FOCUSED_CHUNK_MS {
                        self.focused_ms -= FOCUSED_CHUNK_MS;
                        out.push(Action::Focused {
                            task: self.task_text.clone(),
                            secs: FOCUSED_CHUNK_MS / 1000,
                        });
                    }
                } else {
                    self.off_ms += dt;
                    if self.off_ms >= cfg.grace_secs.max(1) * 1000 {
                        self.off_ms = 0;
                        self.drift_count += 1;
                        let kind = NudgeKind::Drift { app: app.clone(), count: self.drift_count };
                        self.nudge = Some(kind.clone());
                        out.push(Action::OpenNudge(kind));
                    }
                }
            }
        }
        out
    }

    /// The user answered the nudge. Counting starts fresh.
    pub fn resolve(&mut self) {
        self.nudge = None;
        self.off_ms = 0;
    }
}

/// A typed reason long enough to count (trimmed, in characters).
pub fn valid_reason(r: Option<&str>) -> bool {
    r.map(|s| s.trim().chars().count() >= MIN_REASON_CHARS).unwrap_or(false)
}

/// Whether answering `kind` with `action` needs a typed reason. Escalation: the first drift
/// of a task session can be dismissed freely; every repeat drift needs a reason for any way
/// out of the nudge (back, park, allow). Switching always needs one. The workday "pick a
/// task" prompt never does.
pub fn reason_needed(kind: &NudgeKind, action: &str) -> bool {
    match kind {
        NudgeKind::Drift { count, .. } => match action {
            "switch" => true,
            "back" | "park" | "allow" => *count >= 2,
            _ => false,
        },
    }
}

fn clip(s: &str) -> String {
    s.trim().chars().take(MAX_TEXT_CHARS).collect()
}

// ---------------------------------------------------------------------------------------
// Event log (JSONL) for the stats view
// ---------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LogEntry {
    /// Unix epoch milliseconds. The frontend buckets by local day.
    pub ts: u64,
    /// drift | back | park | switch | allow | focused_secs | newtask_park | newtask_switch
    pub kind: String,
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// What was parked (kind "park"). The reason, if one was required, stays in `reason`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secs: Option<u64>,
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Keep the lines newer than `cutoff_ms`; unparseable lines are dropped too. Returns the
/// kept text and whether anything was dropped.
pub fn prune_log(content: &str, cutoff_ms: u64) -> (String, bool) {
    let mut kept = String::new();
    let mut dropped = false;
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<LogEntry>(line) {
            Ok(e) if e.ts >= cutoff_ms => {
                kept.push_str(line);
                kept.push('\n');
            }
            _ => dropped = true,
        }
    }
    (kept, dropped)
}

pub fn read_log_since(path: &Path, since_ms: u64) -> Vec<LogEntry> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok())
        .filter(|e| e.ts >= since_ms)
        .collect()
}

fn append_log(path: &Path, entry: &LogEntry) {
    let Ok(mut line) = serde_json::to_string(entry) else {
        return;
    };
    line.push('\n');
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut f) => {
            if let Err(e) = f.write_all(line.as_bytes()) {
                eprintln!("Focusbox: focus guard log write failed: {e}");
            }
        }
        Err(e) => eprintln!("Focusbox: focus guard log open failed: {e}"),
    }
}

/// Drop entries past retention. Rewrites atomically (temp + rename) and only when
/// something actually expired.
fn prune_log_file(path: &Path) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let cutoff = now_epoch_ms().saturating_sub(LOG_RETENTION_MS);
    let (kept, dropped) = prune_log(&content, cutoff);
    if !dropped {
        return;
    }
    let tmp = path.with_extension("jsonl.tmp");
    let ok = fs::File::create(&tmp)
        .and_then(|mut f| {
            f.write_all(kept.as_bytes())?;
            f.sync_all()
        })
        .and_then(|_| fs::rename(&tmp, path));
    if let Err(e) = ok {
        eprintln!("Focusbox: focus guard log prune failed: {e}");
        let _ = fs::remove_file(&tmp);
    }
}

// ---------------------------------------------------------------------------------------
// Platform layer
// ---------------------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    //! Read-only toward other apps: the only things read are the frontmost app
    //! (NSWorkspace), the HID idle time (CoreGraphics), power assertions (IOKit) and, for a
    //! supported browser while the user is active, its tab address (osascript). No events
    //! are synthesized; no other app is activated except by the explicit "Back to task".
    use super::{
        is_meeting_url, url_host, FrontApp, Sample, ALL_TABS_SCRIPTS, AWAY_BUNDLES, BROWSERS, ZOOM_MEETING_PROCESS,
    };
    use objc2::runtime::AnyObject;
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber};
    use std::sync::Mutex;
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSRunningApplication, NSStatusWindowLevel, NSWindow,
        NSWindowCollectionBehavior, NSWorkspace,
    };
    use objc2_foundation::NSString;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    pub const SUPPORTED: bool = true;
    const OSASCRIPT_TIMEOUT: Duration = Duration::from_millis(1500);

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMCopyAssertionsByProcess(assertions_by_pid: *mut *mut std::ffi::c_void) -> i32;
    }
    /// kCGEventSourceStateHIDSystemState: only real hardware input resets it, so synthetic
    /// events (automation driving a browser over CDP, scripts) never make the user look
    /// present.
    const HID_SYSTEM_STATE: i32 = 1;
    /// kCGAnyInputEventType (~0).
    const ANY_INPUT_EVENT: u32 = u32::MAX;
    /// Assertion types that keep the display awake: what video playback takes. System-
    /// sleep-only assertions (PreventUserIdleSystemSleep, e.g. `caffeinate -i`) don't count.
    const DISPLAY_ASSERTIONS: &[&str] = &["PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion"];

    /// Last tab host read per frontmost pid. While the user is idle the browser isn't
    /// queried (no point poking it, and its tab can't have changed by the user's hand), so
    /// the last known host stands in.
    static LAST_HOST: Mutex<Option<(i32, Option<String>)>> = Mutex::new(None);

    /// Seconds since the last hardware keyboard/mouse/trackpad input. No permission needed.
    fn hid_idle_secs() -> u64 {
        let s = unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT) };
        if s.is_finite() && s > 0.0 {
            s as u64
        } else {
            0
        }
    }

    fn pid_path(pid: i32) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if n <= 0 {
            return None;
        }
        buf.truncate(n as usize);
        String::from_utf8(buf).ok()
    }

    fn number(o: &AnyObject) -> Option<i32> {
        o.downcast_ref::<NSNumber>().map(|n| n.intValue())
    }

    fn float(o: &AnyObject) -> Option<f64> {
        o.downcast_ref::<NSNumber>().map(|n| n.doubleValue())
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut std::ffi::c_void;
    }
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    const NULL_WINDOW_ID: u32 = 0;

    /// Running regular apps (the ones with a Dock icon), minus Focusbox, sorted by name.
    pub fn running_apps() -> Vec<super::RunningApp> {
        objc2::rc::autoreleasepool(|_| {
            let me = std::process::id() as i32;
            let apps = NSWorkspace::sharedWorkspace().runningApplications();
            let mut out: Vec<super::RunningApp> = Vec::new();
            for i in 0..apps.count() {
                let a = apps.objectAtIndex(i);
                if a.activationPolicy() != objc2_app_kit::NSApplicationActivationPolicy::Regular
                    || a.processIdentifier() == me
                {
                    continue;
                }
                let Some(bundle_id) = a.bundleIdentifier().map(|s| s.to_string()) else { continue };
                if out.iter().any(|r| r.bundle_id == bundle_id) {
                    continue;
                }
                let name = a.localizedName().map(|s| s.to_string()).unwrap_or_else(|| bundle_id.clone());
                out.push(super::RunningApp { bundle_id, name });
            }
            out.sort_by_key(|r| r.name.to_lowercase());
            out
        })
    }

    /// Bounds (global points) of `pid`'s frontmost normal window. The window list comes
    /// back front-to-back; the first layer-0 window of that pid with a real size wins.
    /// Only owner pid, layer and bounds are read, none of which need Screen Recording
    /// permission (window names would, and are never touched).
    pub fn front_window_rect(pid: i32) -> Option<super::Rect> {
        if pid <= 0 {
            return None;
        }
        objc2::rc::autoreleasepool(|_| {
            let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, NULL_WINDOW_ID) };
            if raw.is_null() {
                return None;
            }
            // CFArray is toll-free bridged to NSArray; "Copy" = owned, released on drop.
            let list = unsafe { Retained::from_raw(raw.cast::<NSArray>()) }?;
            let s = objc2_foundation::NSString::from_str;
            let (k_pid, k_layer, k_bounds) = (s("kCGWindowOwnerPID"), s("kCGWindowLayer"), s("kCGWindowBounds"));
            let (k_x, k_y, k_w, k_h) = (s("X"), s("Y"), s("Width"), s("Height"));
            for i in 0..list.count() {
                let item = list.objectAtIndex(i);
                let Some(win) = item.downcast_ref::<NSDictionary>() else { continue };
                if win.objectForKey(&k_pid).and_then(|o| number(&o)) != Some(pid) {
                    continue;
                }
                if win.objectForKey(&k_layer).and_then(|o| number(&o)) != Some(0) {
                    continue;
                }
                let Some(b) = win.objectForKey(&k_bounds) else { continue };
                let Some(b) = b.downcast_ref::<NSDictionary>() else { continue };
                let get = |k| b.objectForKey(k).and_then(|o| float(&o));
                let (Some(x), Some(y), Some(w), Some(h)) = (get(&k_x), get(&k_y), get(&k_w), get(&k_h)) else {
                    continue;
                };
                if w >= 50.0 && h >= 50.0 {
                    return Some(super::Rect { x, y, w, h });
                }
            }
            None
        })
    }

    /// Whether the frontmost app holds a display-sleep assertion (video playing).
    ///
    /// The assertion counts as the front app's when it is held by the front app's pid,
    /// made on its behalf (`AssertionOnBehalfOfPID`, which WebKit sets for its media
    /// processes), or held by a process whose executable lives inside the front app's
    /// bundle (Chrome/Arc "Helper (Renderer/GPU)" processes are nested in the .app).
    /// Bundle-path containment was chosen over walking parent pids: helpers are often
    /// launched via launchd/XPC, so the parent chain doesn't reliably reach the app.
    /// Anything else, including background `caffeinate`, is ignored. Any failure = no video.
    fn video_in_front(front_pid: i32, bundle_path: Option<&str>) -> bool {
        let mut raw: *mut std::ffi::c_void = std::ptr::null_mut();
        if unsafe { IOPMCopyAssertionsByProcess(&mut raw) } != 0 || raw.is_null() {
            return false;
        }
        // CFDictionary is toll-free bridged to NSDictionary; "Copy" = we own it, and
        // Retained releases it on drop. Every level is type-checked before use.
        let Some(dict) = (unsafe { Retained::from_raw(raw.cast::<NSDictionary<AnyObject, AnyObject>>()) })
        else {
            return false;
        };
        let bundle_prefix = bundle_path.map(|p| format!("{}/", p.trim_end_matches('/')));
        let type_key = objc2_foundation::NSString::from_str("AssertType");
        let behalf_key = objc2_foundation::NSString::from_str("AssertionOnBehalfOfPID");
        let keys = dict.allKeys();
        for i in 0..keys.count() {
            let key = keys.objectAtIndex(i);
            let Some(pid) = number(&key) else { continue };
            let Some(list) = dict.objectForKey(&key) else { continue };
            let Some(list) = list.downcast_ref::<NSArray>() else { continue };
            for j in 0..list.count() {
                let item = list.objectAtIndex(j);
                let Some(a) = item.downcast_ref::<NSDictionary>() else { continue };
                let ty = a
                    .objectForKey(&type_key)
                    .and_then(|t| t.downcast_ref::<objc2_foundation::NSString>().map(|s| s.to_string()));
                if !ty.map(|t| DISPLAY_ASSERTIONS.contains(&t.as_str())).unwrap_or(false) {
                    continue;
                }
                if pid == front_pid {
                    return true;
                }
                if a.objectForKey(&behalf_key).and_then(|o| number(&o)) == Some(front_pid) {
                    return true;
                }
                if let (Some(prefix), Some(path)) = (&bundle_prefix, pid_path(pid)) {
                    if path.starts_with(prefix.as_str()) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Run a constant AppleScript with a hard deadline. None on any failure: permission
    /// denied (-1743), no window, timeout.
    fn osascript(script: &str) -> Option<String> {
        let mut child = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + OSASCRIPT_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return None;
                    }
                    let mut out = String::new();
                    child.stdout.take()?.read_to_string(&mut out).ok()?;
                    return Some(out.trim().to_string());
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
    }

    /// Last call check and when it ran. Reading every tab of every browser is the costly
    /// part, so the answer is reused for `MEETING_RECHECK`.
    static MEETING: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    const MEETING_RECHECK: Duration = Duration::from_secs(10);

    /// Whether the user is in a Zoom meeting or has a Google Meet / Zoom web call open.
    pub fn in_meeting() -> bool {
        if let Ok(c) = MEETING.lock() {
            if let Some((at, v)) = *c {
                if at.elapsed() < MEETING_RECHECK {
                    return v;
                }
            }
        }
        let v = process_running(ZOOM_MEETING_PROCESS) || objc2::rc::autoreleasepool(|_| meeting_tab_open(mic_users()));
        if let Ok(mut c) = MEETING.lock() {
            *c = Some((Instant::now(), v));
        }
        v
    }

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }
    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            id: u32,
            addr: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            out_size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            id: u32,
            addr: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            io_size: *mut u32,
            out: *mut std::ffi::c_void,
        ) -> i32;
    }
    const AUDIO_SYSTEM_OBJECT: u32 = 1;
    const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const PROCESS_OBJECT_LIST: u32 = u32::from_be_bytes(*b"prs#");
    const PROCESS_PID: u32 = u32::from_be_bytes(*b"ppid");
    const PROCESS_IS_RUNNING_INPUT: u32 = u32::from_be_bytes(*b"piri");

    fn audio_u32(id: u32, selector: u32) -> Option<u32> {
        let addr = AudioObjectPropertyAddress { selector, scope: SCOPE_GLOBAL, element: 0 };
        let mut v: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let st = unsafe {
            AudioObjectGetPropertyData(id, &addr, 0, std::ptr::null(), &mut size, (&mut v as *mut u32).cast())
        };
        (st == 0).then_some(v)
    }

    /// Executable paths of the processes recording from an input device right now
    /// (CoreAudio's per-process objects, macOS 14.2+; no permission needed). None when
    /// CoreAudio can't say, so callers fall back to not requiring it.
    fn mic_users() -> Option<Vec<String>> {
        let addr = AudioObjectPropertyAddress { selector: PROCESS_OBJECT_LIST, scope: SCOPE_GLOBAL, element: 0 };
        let mut size: u32 = 0;
        let st = unsafe { AudioObjectGetPropertyDataSize(AUDIO_SYSTEM_OBJECT, &addr, 0, std::ptr::null(), &mut size) };
        if st != 0 {
            return None;
        }
        let mut ids = vec![0u32; size as usize / std::mem::size_of::<u32>()];
        let st = unsafe {
            AudioObjectGetPropertyData(AUDIO_SYSTEM_OBJECT, &addr, 0, std::ptr::null(), &mut size, ids.as_mut_ptr().cast())
        };
        if st != 0 {
            return None;
        }
        ids.truncate(size as usize / std::mem::size_of::<u32>());
        Some(
            ids.into_iter()
                .filter(|&id| audio_u32(id, PROCESS_IS_RUNNING_INPUT).is_some_and(|v| v != 0))
                .filter_map(|id| audio_u32(id, PROCESS_PID).and_then(|pid| pid_path(pid as i32)))
                .collect(),
        )
    }

    /// Any process with this exact short name (same user's processes; no permission).
    fn process_running(name: &str) -> bool {
        let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if n <= 0 {
            return false;
        }
        // Room for processes started between the two calls.
        let mut pids = vec![0i32; n as usize + 64];
        let bytes = (pids.len() * std::mem::size_of::<i32>()) as i32;
        let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if n <= 0 {
            return false;
        }
        pids.truncate((n as usize).min(pids.len()));
        let mut buf = [0u8; 256];
        pids.iter().any(|&pid| {
            let len = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
            len > 0 && &buf[..len as usize] == name.as_bytes()
        })
    }

    /// A Meet room or Zoom web call open in any tab of a running supported browser, while
    /// that browser (or one of its helpers, which live inside its .app) uses the mic. The
    /// mic part stops a tab left open after the call from silencing the guard for the rest
    /// of the day; Meet keeps the mic open while muted, so a muted call still counts.
    fn meeting_tab_open(mic: Option<Vec<String>>) -> bool {
        ALL_TABS_SCRIPTS.iter().any(|(bundle, script)| {
            let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle));
            let Some(app) = apps.firstObject() else { return false };
            if let Some(users) = &mic {
                let Some(path) = app.bundleURL().and_then(|u| u.path()).map(|p| p.to_string()) else {
                    return false;
                };
                let prefix = format!("{}/", path.trim_end_matches('/'));
                if !users.iter().any(|u| u.starts_with(&prefix)) {
                    return false;
                }
            }
            osascript(script).is_some_and(|out| out.split(", ").any(is_meeting_url))
        })
    }

    /// The frontmost app, plus the active tab's host for a supported browser.
    /// NSWorkspace needs no permission; the browser read needs Automation consent once.
    ///
    /// Runs inside its own autorelease pool: the watcher thread never exits, so anything
    /// AppKit autoreleases here would otherwise pile up for the life of the process.
    /// `idle_after_secs` is the user's idle threshold: past it, the browser isn't queried
    /// and the (IOKit) video check runs instead. Below it, the video check is skipped, which
    /// keeps the 2s loop cheap.
    pub fn sample(idle_after_secs: u64) -> Sample {
        objc2::rc::autoreleasepool(|_| sample_inner(idle_after_secs))
    }

    fn sample_inner(idle_after_secs: u64) -> Sample {
        let idle_secs = hid_idle_secs();
        let idle = idle_secs >= idle_after_secs.max(1);
        let ws = NSWorkspace::sharedWorkspace();
        let Some(app) = ws.frontmostApplication() else {
            return Sample::Away;
        };
        let bundle_id = app.bundleIdentifier().map(|s| s.to_string());
        if let Some(b) = &bundle_id {
            if AWAY_BUNDLES.contains(&b.as_str()) {
                return Sample::Away;
            }
        }
        let name = app
            .localizedName()
            .map(|s| s.to_string())
            .or_else(|| bundle_id.clone())
            .unwrap_or_else(|| "Unknown app".into());
        let pid = app.processIdentifier();
        let is_self = pid == std::process::id() as i32;
        let browser = match &bundle_id {
            Some(b) if !is_self => BROWSERS.iter().find(|(id, _)| id == b),
            _ => None,
        };
        let domain = match browser {
            None => None,
            Some(_) if idle => LAST_HOST
                .lock()
                .ok()
                .and_then(|c| c.as_ref().filter(|(p, _)| *p == pid).and_then(|(_, h)| h.clone())),
            Some((_, script)) => {
                let host = osascript(script).and_then(|u| url_host(&u));
                if let Ok(mut c) = LAST_HOST.lock() {
                    *c = Some((pid, host.clone()));
                }
                host
            }
        };
        let video = idle && !is_self && {
            let bundle_path = app.bundleURL().and_then(|u| u.path()).map(|p| p.to_string());
            video_in_front(pid, bundle_path.as_deref())
        };
        Sample::Front(FrontApp { bundle_id, name, domain, is_self, idle_secs, video, pid })
    }

    /// Bring a running app forward. False if it isn't running.
    pub fn activate_bundle(bundle: &str) -> bool {
        objc2::rc::autoreleasepool(|_| {
            let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(
                &NSString::from_str(bundle),
            );
            match apps.firstObject() {
                Some(a) => a.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows),
                None => false,
            }
        })
    }

    /// Tag window-vibrancy 0.6 gives the NSVisualEffectView it adds under the window's
    /// content view (window-vibrancy src/macos/internal.rs NS_VIEW_TAG_BLUR_VIEW), which is
    /// how Tauri's `effects` applies FullScreenUI.
    const BLUR_VIEW_TAG: isize = 91376254;

    /// Show or hide the window's blur view without removing it. Main thread only.
    ///
    /// # Safety
    /// `ns_window` must be the live NSWindow pointer Tauri returned for this window.
    pub unsafe fn set_blur(ns_window: *mut std::ffi::c_void, on: bool) {
        if ns_window.is_null() {
            return;
        }
        let w: &NSWindow = &*(ns_window as *const NSWindow);
        if let Some(blur) = w.contentView().and_then(|v| v.viewWithTag(BLUR_VIEW_TAG)) {
            blur.setHidden(!on);
        }
    }

    /// Bring a window to the front without making it key or activating Focusbox (the
    /// toast). Tauri's `show()` is `makeKeyAndOrderFront:`, which would take keyboard
    /// focus from Focusbox's own main window. Main thread only.
    ///
    /// # Safety
    /// `ns_window` must be the live NSWindow pointer Tauri returned for this window.
    pub unsafe fn order_front_quietly(ns_window: *mut std::ffi::c_void) -> bool {
        if ns_window.is_null() {
            return false;
        }
        let w: &NSWindow = &*(ns_window as *const NSWindow);
        w.orderFrontRegardless();
        true
    }

    /// Make Focusbox the active app so the nudge is actually in front.
    #[allow(deprecated)]
    pub fn activate_self() {
        objc2::rc::autoreleasepool(|_| {
            let me = NSRunningApplication::currentApplication();
            me.activateWithOptions(
                NSApplicationActivationOptions::ActivateAllWindows
                    | NSApplicationActivationOptions::ActivateIgnoringOtherApps,
            );
        })
    }

    /// Raise the nudge above the menu bar and let it follow the user across Spaces,
    /// including over another app's full-screen Space. Must run on the main thread.
    ///
    /// # Safety
    /// `ns_window` must be the live NSWindow pointer Tauri returned for this window.
    pub unsafe fn raise_window(ns_window: *mut std::ffi::c_void) {
        if ns_window.is_null() {
            return;
        }
        let w: &NSWindow = &*(ns_window as *const NSWindow);
        w.setLevel(NSStatusWindowLevel);
        w.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::Sample;

    pub const SUPPORTED: bool = false;

    pub fn sample(_idle_after_secs: u64) -> Sample {
        Sample::Away
    }
    pub fn in_meeting() -> bool {
        false
    }
    pub fn activate_bundle(_bundle: &str) -> bool {
        false
    }
    pub fn activate_self() {}
    /// # Safety
    /// No-op off macOS.
    pub unsafe fn set_blur(_ns_window: *mut std::ffi::c_void, _on: bool) {}
    /// # Safety
    /// Off macOS there's no quiet show; the caller falls back to `show()`.
    pub unsafe fn order_front_quietly(_ns_window: *mut std::ffi::c_void) -> bool {
        false
    }
    pub fn front_window_rect(_pid: i32) -> Option<super::Rect> {
        None
    }
    pub fn running_apps() -> Vec<super::RunningApp> {
        Vec::new()
    }
    /// # Safety
    /// No-op off macOS.
    pub unsafe fn raise_window(_ns_window: *mut std::ffi::c_void) {}
}

// ---------------------------------------------------------------------------------------
// Shared state, watcher thread, nudge window
// ---------------------------------------------------------------------------------------

/// What the nudge window renders. Fetched by the nudge on mount (`get_nudge_state`) rather
/// than pushed by event, so a window that loads late can't miss it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NudgePayload {
    /// "drift" | "preview"
    pub kind: String,
    pub task: String,
    /// The off-task site if known, else the app name.
    pub label: Option<String>,
    pub app_name: Option<String>,
    pub domain: Option<String>,
    pub drift_count: u32,
    /// From the 2nd drift of a task session on, every answer (back, park, allow) needs a
    /// typed reason. Switching always does.
    pub reason_required: bool,
    pub min_reason_chars: usize,
}

#[derive(Default)]
struct Inner {
    cfg: GuardConfig,
    machine: Machine,
    /// Allowances added from the nudge this run, per task key. Merged into whatever the
    /// frontend pushes, so an "Allow" can't be undone by a config push racing the event
    /// that persists it.
    session_allow: std::collections::HashMap<String, (HashSet<String>, HashSet<String>)>,
    /// A Settings "Preview nudge" on screen. Entirely separate from `machine`: it never
    /// counts as a drift, never touches escalation and never reaches the log. A real
    /// nudge always wins over it.
    preview: Option<Preview>,
    /// The app the user was in when the current nudge (or preview) was raised; the nudge
    /// goes on the monitor holding that app's front window.
    target_pid: Option<i32>,
    /// Whether the main window has pushed a config yet this run. The first push restores
    /// state (e.g. a pause that was already running before a restart), so it doesn't log.
    config_seen: bool,
}

/// What a config push changed, for the caller to act on outside the lock.
#[derive(Debug, PartialEq, Eq)]
struct Applied {
    /// A pause started (or was extended) with this push: its length in seconds.
    pause_started: Option<u64>,
    /// Pausing closed an open nudge.
    closed_nudge: bool,
}

#[derive(Clone, Debug)]
struct Preview {
    payload: NudgePayload,
    blur: bool,
}

impl Inner {
    /// "Allow" from the nudge: on task for this task from now on, even before the main
    /// window's config push (which persists it) arrives.
    fn allow_for_task(&mut self, task_key: &str, app: Option<&str>, domain: Option<&str>) {
        let entry = self.session_allow.entry(task_key.to_string()).or_default();
        if let Some(a) = app {
            entry.0.insert(a.to_string());
        }
        if let Some(d) = domain {
            entry.1.insert(d.to_string());
        }
    }

    /// Take a config push from the main window.
    ///
    /// Session allowances the push already carries are dropped here: from then on the
    /// main window's list is the truth, so removing one in Settings really removes it.
    /// Until the push arrives they still bridge the gap (an "Allow" can't be lost to a
    /// push that raced the event persisting it).
    fn apply_config(&mut self, config: GuardConfig, now: u64) -> Applied {
        // A pause is capped at a day: a bad clock or a crafted value can't switch it off
        // for good.
        let paused_until = config.paused_until.min(now + 24 * 60 * 60 * 1000);
        let first = !self.config_seen;
        self.config_seen = true;
        let pause_started = if first {
            None
        } else {
            pause_started(self.cfg.paused_until, paused_until, now)
        };
        // Pausing answers an open nudge (no reason needed). Pausing is only offered in
        // Settings and the tray, never on the nudge itself.
        let closed_nudge = pause_started.is_some() && self.machine.nudge().is_some();
        if closed_nudge {
            self.machine.resolve();
        }
        let cfg = GuardConfig {
            task_text: clip(&config.task_text),
            task_key: clip(&config.task_key),
            grace_secs: config.grace_secs.clamp(5, 3600),
            idle_after_secs: config.idle_after_secs.clamp(60, 3600),
            paused_until,
            ..config
        };
        if let Some((apps, domains)) = self.session_allow.get_mut(&cfg.task_key) {
            apps.retain(|a| !cfg.allow_apps.iter().any(|x| x.trim().eq_ignore_ascii_case(a)));
            domains.retain(|d| !cfg.allow_domains.iter().any(|x| x.trim().eq_ignore_ascii_case(d)));
            if apps.is_empty() && domains.is_empty() {
                self.session_allow.remove(&cfg.task_key);
            }
        }
        self.cfg = cfg;
        Applied { pause_started, closed_nudge }
    }

    fn effective_cfg(&self) -> GuardConfig {
        let mut cfg = self.cfg.clone();
        if let Some((apps, domains)) = self.session_allow.get(&cfg.task_key) {
            cfg.allow_apps.extend(apps.iter().cloned());
            cfg.allow_domains.extend(domains.iter().cloned());
        }
        cfg
    }

    /// Some(blur) when a nudge (real, else preview) should be on screen.
    fn wanted(&self) -> Option<bool> {
        if self.machine.nudge().is_some() {
            Some(self.cfg.blur)
        } else {
            self.preview.as_ref().map(|p| p.blur)
        }
    }

    fn payload(&self) -> Option<NudgePayload> {
        if self.machine.nudge().is_none() {
            return self.preview.as_ref().map(|p| p.payload.clone());
        }
        match self.machine.nudge()? {
            NudgeKind::Drift { app, count } => Some(NudgePayload {
                kind: "drift".into(),
                task: self.cfg.task_text.clone(),
                label: Some(app.label()),
                app_name: Some(app.name.clone()),
                domain: app.domain.clone(),
                drift_count: *count,
                reason_required: *count >= 2,
                min_reason_chars: MIN_REASON_CHARS,
            }),
        }
    }
}

pub struct GuardState {
    inner: Mutex<Inner>,
    log_path: Mutex<Option<PathBuf>>,
    log_lock: Mutex<()>,
}

impl Default for GuardState {
    fn default() -> Self {
        GuardState {
            inner: Mutex::new(Inner::default()),
            log_path: Mutex::new(None),
            log_lock: Mutex::new(()),
        }
    }
}

impl GuardState {
    fn log(&self, entry: LogEntry) {
        let path = self.log_path.lock().ok().and_then(|p| p.clone());
        if let (Some(path), Ok(_g)) = (path, self.log_lock.lock()) {
            append_log(&path, &entry);
        }
    }

    /// Put a preview up. False (and nothing changes) while a real nudge is open.
    pub fn begin_preview(&self, task: &str, blur: bool) -> bool {
        let Ok(mut inner) = self.inner.lock() else { return false };
        if inner.machine.nudge().is_some() {
            return false;
        }
        let task = clip(task);
        // From Settings: Focusbox's own window is the one in front.
        inner.target_pid = Some(std::process::id() as i32);
        inner.preview = Some(Preview {
            payload: NudgePayload {
                kind: "preview".into(),
                task: if task.is_empty() { "Your task".into() } else { task },
                label: Some("Example site".into()),
                app_name: Some("Example site".into()),
                domain: None,
                drift_count: 0,
                reason_required: false,
                min_reason_chars: MIN_REASON_CHARS,
            },
            blur,
        });
        true
    }

    /// Drop the preview. True if one was up.
    pub fn end_preview(&self) -> bool {
        self.inner.lock().map(|mut i| i.preview.take().is_some()).unwrap_or(false)
    }

    fn log_kind(&self, kind: &str, task: &str, app: Option<&FrontApp>, reason: Option<&str>) {
        self.log(LogEntry {
            ts: now_epoch_ms(),
            kind: kind.into(),
            task: clip(task),
            app: app.map(|a| a.name.clone()),
            domain: app.and_then(|a| a.domain.clone()),
            reason: reason.map(clip),
            text: None,
            secs: None,
        });
    }
}

/// Called once from `setup`: resolve the log path, prune old entries and (macOS only)
/// start the watcher thread.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Arc<GuardState>>().inner().clone();
    if let Ok(dir) = app.path().app_data_dir() {
        let path = dir.join(LOG_FILE);
        prune_log_file(&path);
        if let Ok(mut p) = state.log_path.lock() {
            *p = Some(path);
        }
    }
    if platform::SUPPORTED {
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("focus-guard".into())
            .spawn(move || watch(app, state));
        if let Err(e) = spawned {
            eprintln!("Focusbox: could not start the focus guard: {e}");
        }
    }
}

fn watch<R: Runtime>(app: AppHandle<R>, state: Arc<GuardState>) {
    let epoch = Instant::now();
    loop {
        std::thread::sleep(TICK);
        let (cfg, mode) = {
            let Ok(inner) = state.inner.lock() else { return };
            let cfg = inner.effective_cfg();
            let mode = effective_mode(&cfg, in_workday(&cfg.workday, Utc::now()), now_epoch_ms());
            (cfg, mode)
        };
        // Sample outside the lock: the browser read can take up to 1.5s.
        let nudge_up = state.inner.lock().map(|i| i.machine.nudge().is_some()).unwrap_or(false);
        // A nudge is only answered through its buttons. If its window went off screen some
        // other way (Cmd+W is turned into a hide, see lib.rs), put it back rather than
        // staying frozen. A hidden window with no nudge up is just parked for reuse.
        if nudge_up && !nudge_visible(&app) {
            open_nudge_window(&app);
        }
        // The call check runs even with a nudge up, so joining a call clears it.
        let sample = if mode == Mode::Idle {
            None
        } else if platform::in_meeting() {
            Some(Sample::Meeting)
        } else if nudge_up {
            None
        } else {
            Some(platform::sample(cfg.idle_after_secs))
        };
        let now_ms = epoch.elapsed().as_millis() as u64;
        let actions = {
            let Ok(mut inner) = state.inner.lock() else { return };
            inner.machine.step(&cfg, mode, sample.as_ref(), now_ms)
        };
        for action in actions {
            match action {
                Action::OpenNudge(kind) => {
                    // A real nudge replaces any preview on screen (same window, refreshed).
                    state.end_preview();
                    // The app in front when it fired (the drifted-to app), never
                    // Focusbox's guess; else whatever the sample saw in front.
                    let NudgeKind::Drift { app: off, .. } = &kind;
                    let pid = match &sample {
                        _ if off.pid > 0 => Some(off.pid),
                        Some(Sample::Front(a)) if a.pid > 0 => Some(a.pid),
                        _ => None,
                    };
                    if let Ok(mut i) = state.inner.lock() {
                        i.target_pid = pid;
                    }
                    state.log_kind("drift", &cfg.task_text, Some(off), None);
                    open_nudge_window(&app);
                }
                Action::CloseNudge => close_nudge_window(&app),
                Action::Away { task, secs } => state.log(LogEntry {
                    ts: now_epoch_ms(),
                    kind: "away_secs".into(),
                    task: clip(&task),
                    app: None,
                    domain: None,
                    reason: None,
                    text: None,
                    secs: Some(secs),
                }),
                Action::Focused { task, secs } => state.log(LogEntry {
                    ts: now_epoch_ms(),
                    kind: "focused_secs".into(),
                    task: clip(&task),
                    app: None,
                    domain: None,
                    reason: None,
                    text: None,
                    secs: Some(secs),
                }),
            }
        }
    }
}

/// One step in presenting or dismissing a long-lived window (the nudge, the toast).
///
/// These windows are created once and then only shown and hidden, never destroyed:
/// tearing a WKWebView down while a display-link refresh is still pending crashed WebKit
/// on the main thread (EXC_BAD_ACCESS in ScrollingTree::takePendingScrollUpdates, twice on
/// 2026-10-05). Moving or resizing happens only while the window is hidden.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinOp {
    /// Build it, hidden, already placed on the target monitor.
    Create,
    Hide,
    /// Move/resize onto the target monitor.
    Place,
    /// Show or hide the native blur view (it is always there, see `platform::set_blur`).
    Blur(bool),
    /// Tell the page to re-fetch its payload and reset its local state.
    Refresh,
    /// Tell the page to clear itself (so a later show never flashes stale content).
    Reset,
    Show,
    /// Status-bar level, all Spaces, over full-screen apps.
    Raise,
    Focus,
}

/// Steps to put the nudge up. `moved` = it is not already covering the target monitor.
pub fn plan_nudge_present(exists: bool, visible: bool, moved: bool, blur: bool) -> Vec<WinOp> {
    use WinOp::*;
    let mut ops = Vec::new();
    if !exists {
        ops.push(Create);
    } else {
        // Never move or swap the content of a window that's on screen (e.g. a preview
        // turning into a real nudge): take it down first, then show it again.
        if visible {
            ops.push(Hide);
        }
        if moved {
            ops.push(Place);
        }
    }
    ops.push(Blur(blur));
    if exists {
        ops.push(Refresh);
    }
    ops.extend([Show, Raise, Focus]);
    ops
}

/// Steps to take the nudge down: hide it and clear the page. Nothing if it never existed.
pub fn plan_nudge_dismiss(exists: bool) -> Vec<WinOp> {
    if exists {
        vec![WinOp::Hide, WinOp::Reset]
    } else {
        Vec::new()
    }
}

/// Covering `m` already? Compares physical position and size.
fn covers<R: Runtime>(w: &tauri::WebviewWindow<R>, m: &tauri::Monitor) -> bool {
    let pos_ok = w.outer_position().map(|p| p == *m.position()).unwrap_or(false);
    let size_ok = w.inner_size().map(|s| s == *m.size()).unwrap_or(false);
    pos_ok && size_ok
}

fn place<R: Runtime>(w: &tauri::WebviewWindow<R>, m: &tauri::Monitor) {
    let scale = m.scale_factor();
    let _ = w.set_position(m.position().to_logical::<f64>(scale));
    let _ = w.set_size(m.size().to_logical::<f64>(scale));
}

fn build_nudge<R: Runtime>(app: &AppHandle<R>, monitor: Option<&tauri::Monitor>) -> Option<tauri::WebviewWindow<R>> {
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        NUDGE_LABEL,
        tauri::WebviewUrl::App("index.html?view=nudge".into()),
    )
    .title("Focusbox")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    // Built hidden; WinOp::Show puts it up.
    .visible(false)
    .focused(false);
    // Translucent on macOS: the desktop shows through and the page paints a theme tint over
    // it (styles.css, .nudge). The FullScreenUI blur view is always created; whether it's
    // visible is the "Blur behind nudge" setting, applied on every show (WinOp::Blur), so
    // changing it never needs a new window. Needs macos-private-api + app.macOSPrivateApi.
    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        builder = builder.transparent(true).effects(
            EffectsBuilder::new()
                .effect(Effect::FullScreenUI)
                .state(EffectState::Active)
                .build(),
        );
    }
    match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let pos = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            builder = builder.position(pos.x, pos.y).inner_size(size.width, size.height);
        }
        None => builder = builder.maximized(true),
    }
    match builder.build() {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("Focusbox: could not create the focus nudge: {e}");
            None
        }
    }
}

/// Run a plan against the nudge window. Main thread only.
fn run_nudge_ops<R: Runtime>(app: &AppHandle<R>, ops: &[WinOp], monitor: Option<&tauri::Monitor>) {
    let mut w = app.get_webview_window(NUDGE_LABEL);
    for op in ops {
        match op {
            WinOp::Create => w = build_nudge(app, monitor),
            WinOp::Hide => {
                if let Some(w) = &w {
                    let _ = w.hide();
                }
            }
            WinOp::Place => {
                if let (Some(w), Some(m)) = (&w, monitor) {
                    place(w, m);
                }
            }
            WinOp::Blur(on) => {
                if let Some(ns) = w.as_ref().and_then(|w| w.ns_window_ptr().ok()) {
                    unsafe { platform::set_blur(ns, *on) };
                }
            }
            WinOp::Refresh => {
                if let Some(w) = &w {
                    let _ = w.emit_to(NUDGE_LABEL, "nudge://refresh", ());
                }
            }
            WinOp::Reset => {
                if let Some(w) = &w {
                    let _ = w.emit_to(NUDGE_LABEL, "nudge://reset", ());
                }
            }
            WinOp::Show => {
                if let Some(w) = &w {
                    let _ = w.show();
                }
            }
            WinOp::Raise => {
                if let Some(ns) = w.as_ref().and_then(|w| w.ns_window_ptr().ok()) {
                    unsafe { platform::raise_window(ns) };
                }
            }
            WinOp::Focus => {
                if let Some(w) = &w {
                    platform::activate_self();
                    let _ = w.set_focus();
                }
            }
        }
    }
}

/// Whether the nudge window is on screen (it is never destroyed, so "exists" isn't it).
fn nudge_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(NUDGE_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

fn open_nudge_window<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let app = handle;
        // Re-check on the main thread: the nudge may have been answered between the
        // caller's decision and now, and an orphan full-screen window has no way out.
        let state = app.state::<Arc<GuardState>>().inner().clone();
        let Some((blur, pid)) = state.inner.lock().ok().and_then(|i| i.wanted().map(|b| (b, i.target_pid)))
        else {
            return;
        };
        let monitor = target_monitor(&app, pid);
        let existing = app.get_webview_window(NUDGE_LABEL);
        let visible = existing.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false);
        let moved = match (&existing, &monitor) {
            (Some(w), Some(m)) => !covers(w, m),
            _ => false,
        };
        let ops = plan_nudge_present(existing.is_some(), visible, moved, blur);
        run_nudge_ops(&app, &ops, monitor.as_ref());
    });
}

/// Where the nudge goes: the monitor holding `pid`'s front window (macOS), else the
/// cursor's monitor, else the primary. Typing in one screen while the pointer rests on the
/// other is common, so the cursor is only a fallback.
fn target_monitor<R: Runtime>(app: &AppHandle<R>, pid: Option<i32>) -> Option<tauri::Monitor> {
    if let Some(rect) = pid.and_then(platform::front_window_rect) {
        if let Ok(monitors) = app.available_monitors() {
            let rects: Vec<Rect> = monitors
                .iter()
                .map(|m| monitor_points((m.position().x, m.position().y), (m.size().width, m.size().height), m.scale_factor()))
                .collect();
            if let Some(i) = pick_monitor(rect, &rects) {
                return monitors.into_iter().nth(i);
            }
        }
    }
    app.cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

/// Take the nudge down: hide it (never destroy, see `WinOp`) and clear the page.
fn close_nudge_window<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let exists = handle.get_webview_window(NUDGE_LABEL).is_some();
        run_nudge_ops(&handle, &plan_nudge_dismiss(exists), None);
    });
}

/// Put a window at the nudge's level (above the menu bar, on every Space, over full-screen
/// apps) without ordering it front or making it key. Used by the park toast. No-op off macOS.
pub(crate) fn raise_webview_window<R: Runtime>(w: &tauri::WebviewWindow<R>) {
    if let Ok(ns) = w.ns_window_ptr() {
        unsafe { platform::raise_window(ns) };
    }
}

/// Order a window front without focusing it or activating Focusbox (macOS); plain
/// `show()` elsewhere. Main thread only.
pub(crate) fn show_quietly<R: Runtime>(w: &tauri::WebviewWindow<R>) {
    let done = w.ns_window_ptr().map(|ns| unsafe { platform::order_front_quietly(ns) }).unwrap_or(false);
    if !done {
        let _ = w.show();
    }
}

/// `WebviewWindow::ns_window` only exists on macOS; this keeps the call sites portable.
trait NsWindowPtr {
    fn ns_window_ptr(&self) -> Result<*mut std::ffi::c_void, ()>;
}
impl<R: Runtime> NsWindowPtr for tauri::WebviewWindow<R> {
    #[cfg(target_os = "macos")]
    fn ns_window_ptr(&self) -> Result<*mut std::ffi::c_void, ()> {
        self.ns_window().map_err(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    fn ns_window_ptr(&self) -> Result<*mut std::ffi::c_void, ()> {
        Err(())
    }
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Back to the app the user was last on task in; Focusbox's main window otherwise.
fn back_to_task<R: Runtime>(app: &AppHandle<R>, bundle: Option<String>) {
    let reactivated = bundle.map(|b| platform::activate_bundle(&b)).unwrap_or(false);
    if !reactivated {
        show_main(app);
    }
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// True only where the watcher can actually see other apps (macOS).
#[tauri::command]
pub fn guard_supported() -> bool {
    platform::SUPPORTED
}

#[tauri::command]
pub fn guard_set_config<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<GuardState>>,
    config: GuardConfig,
) -> Result<(), String> {
    let now = now_epoch_ms();
    let (applied, task) = {
        let mut inner = state.inner.lock().map_err(|_| "guard state poisoned".to_string())?;
        let applied = inner.apply_config(config, now);
        (applied, inner.cfg.task_text.clone())
    };
    let (started, closed_nudge) = (applied.pause_started, applied.closed_nudge);
    if let Some(secs) = started {
        state.log(LogEntry {
            ts: now,
            kind: "pause".into(),
            task: task.clone(),
            app: None,
            domain: None,
            reason: None,
            text: closed_nudge.then(|| "closed an open nudge".to_string()),
            // Whole minutes, as chosen.
            secs: Some((secs + 30) / 60 * 60),
        });
    }
    if closed_nudge {
        close_nudge_window(&app);
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    pub bundle_id: String,
    pub name: String,
}

/// Regular (Dock) apps running now, for Settings' "Add app" picker. Read-only; macOS only
/// (empty elsewhere). Async so it never runs on the main thread.
#[tauri::command]
pub async fn guard_running_apps() -> Result<Vec<RunningApp>, String> {
    Ok(platform::running_apps())
}

/// In a Zoom or Google Meet call right now (macOS; always false elsewhere). The main
/// window holds back its in-app "Start the timer?" prompt while this is true.
#[tauri::command]
pub async fn guard_in_meeting() -> Result<bool, String> {
    Ok(platform::in_meeting())
}

/// Settings → "Preview nudge": show the real nudge window with a demo payload, using the
/// given blur setting. Main window only (see capabilities). Returns "ok", or
/// "real_nudge_open" when a real nudge is up (it is left alone).
#[tauri::command]
pub async fn guard_preview_nudge<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<GuardState>>,
    task_text: String,
    blur: bool,
) -> Result<String, String> {
    if !state.begin_preview(&task_text, blur) {
        return Ok("real_nudge_open".into());
    }
    open_nudge_window(&app);
    Ok("ok".into())
}

#[tauri::command]
pub fn get_nudge_state(state: State<'_, Arc<GuardState>>) -> Option<NudgePayload> {
    state.inner.lock().ok().and_then(|i| i.payload())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AllowEvent {
    pub task_key: String,
    pub app: Option<String>,
    pub domain: Option<String>,
}

/// The user's answer to the nudge.
///
/// From the 2nd drift of a task session on, `back`, `park` and `allow` all require a
/// `reason` (see [`reason_needed`]); `switch` always does.
///
/// - `back`: dismiss and return to the last on-task app.
/// - `park`: send `text` to Todoist (queued if offline), then back to task.
/// - `switch`: `reason` required. Logs it and tells the main window to clear the Focus
///   card; the guard then waits for the next focus.
/// - `allow`: add the off-task site (or app, if no site) to this task's allow-list, then
///   back to that app.
/// - `close`: only when no nudge is open (a window left behind by a race); closes it.
///
/// Returns "ok", or for `park` the Todoist outcome ("sent" | "queued" | "rejected" |
/// "no_token" | "auth_blocked").
#[tauri::command]
pub async fn nudge_resolve<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<GuardState>>,
    action: String,
    reason: Option<String>,
    text: Option<String>,
) -> Result<String, String> {
    let (kind, task, task_key, back_bundle) = {
        let inner = state.inner.lock().map_err(|_| "guard state poisoned".to_string())?;
        let Some(kind) = inner.machine.nudge().cloned() else {
            drop(inner);
            // "close" answers a preview (or a window left behind by a race). Nothing is
            // logged and the drift state is untouched.
            if action == "close" {
                state.end_preview();
                close_nudge_window(&app);
                return Ok("ok".into());
            }
            return Err("no nudge is open".into());
        };
        (
            kind,
            inner.cfg.task_text.clone(),
            inner.cfg.task_key.clone(),
            inner.machine.last_on_task_bundle().map(str::to_string),
        )
    };
    let reason = reason.map(|r| clip(&r)).filter(|r| !r.is_empty());
    if reason_needed(&kind, &action) && !valid_reason(reason.as_deref()) {
        return Err(format!("a reason of at least {MIN_REASON_CHARS} characters is required"));
    }
    let mut result = "ok".to_string();

    match (&kind, action.as_str()) {
        (NudgeKind::Drift { app: off, .. }, "back") => {
            state.log_kind("back", &task, Some(off), reason.as_deref());
            finish(&state, &app);
            back_to_task(&app, back_bundle);
        }
        (NudgeKind::Drift { app: off, .. }, "park") => {
            let what = text.map(|t| clip(&t)).filter(|t| !t.is_empty()).unwrap_or_else(|| off.label());
            // Toast on the nudge's monitor (the nudge is still up at this point).
            result = crate::todoist::park_and_confirm(&app, &what, NUDGE_LABEL).await?;
            state.log(LogEntry {
                ts: now_epoch_ms(),
                kind: "park".into(),
                task: clip(&task),
                app: Some(off.name.clone()),
                domain: off.domain.clone(),
                reason: reason.clone(),
                text: Some(what),
                secs: None,
            });
            finish(&state, &app);
            back_to_task(&app, back_bundle);
        }
        (NudgeKind::Drift { app: off, .. }, "switch") => {
            state.log_kind("switch", &task, Some(off), reason.as_deref());
            finish(&state, &app);
            let _ = app.emit_to("main", "guard://switch", ());
            show_main(&app);
        }
        (NudgeKind::Drift { app: off, .. }, "allow") => {
            let (allow_app, allow_domain) = match &off.domain {
                Some(d) => (None, Some(d.clone())),
                None => (off.bundle_id.clone(), None),
            };
            if allow_app.is_none() && allow_domain.is_none() {
                return Err("nothing to allow".into());
            }
            {
                let mut inner = state.inner.lock().map_err(|_| "guard state poisoned".to_string())?;
                inner.allow_for_task(&task_key, allow_app.as_deref(), allow_domain.as_deref());
            }
            state.log_kind("allow", &task, Some(off), reason.as_deref());
            let _ = app.emit_to(
                "main",
                "guard://allow",
                AllowEvent { task_key, app: allow_app, domain: allow_domain },
            );
            finish(&state, &app);
            if !off.bundle_id.as_deref().map(platform::activate_bundle).unwrap_or(false) {
                show_main(&app);
            }
        }
        _ => return Err(format!("unknown action: {action}")),
    }
    Ok(result)
}

fn finish<R: Runtime>(state: &GuardState, app: &AppHandle<R>) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.machine.resolve();
        inner.preview = None;
    }
    close_nudge_window(app);
}

/// Log the outcome of the in-app "new task while one is active" prompt. Async (like
/// `guard_stats`) so its file I/O never runs on the main thread.
#[tauri::command]
pub async fn guard_log_newtask(
    state: State<'_, Arc<GuardState>>,
    kind: String,
    task: String,
    reason: Option<String>,
) -> Result<(), String> {
    if kind != "newtask_park" && kind != "newtask_switch" {
        return Err(format!("unknown kind: {kind}"));
    }
    if kind == "newtask_switch" && !valid_reason(reason.as_deref()) {
        return Err(format!("a reason of at least {MIN_REASON_CHARS} characters is required"));
    }
    state.log_kind(&kind, &task, None, reason.as_deref());
    Ok(())
}

/// Raw log entries from the last `days` days (capped at the retention window). The
/// frontend buckets them by local day.
#[tauri::command]
pub async fn guard_stats(state: State<'_, Arc<GuardState>>, days: u32) -> Result<Vec<LogEntry>, String> {
    let Some(path) = state.log_path.lock().ok().and_then(|p| p.clone()) else {
        return Ok(Vec::new());
    };
    let span = (days.clamp(1, 90) as u64 + 1) * 24 * 60 * 60 * 1000;
    let _g = state.log_lock.lock();
    Ok(read_log_since(&path, now_epoch_ms().saturating_sub(span)))
}

// ---------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn cfg() -> GuardConfig {
        GuardConfig {
            enabled: true,
            has_task: true,
            task_text: "Fix the build".into(),
            task_key: "fix the build".into(),
            timer: TimerState::Running,
            allow_apps: vec!["com.microsoft.VSCode".into()],
            allow_domains: vec!["github.com".into()],
            grace_secs: 30,
            workday: Workday::default(),
            blur: true,
            idle_after_secs: 180,
            paused_until: 0,
        }
    }

    fn app(bundle: &str, domain: Option<&str>) -> Sample {
        Sample::Front(FrontApp {
            bundle_id: Some(bundle.into()),
            name: bundle.rsplit('.').next().unwrap().into(),
            domain: domain.map(str::to_string),
            is_self: false,
            ..Default::default()
        })
    }

    /// Like `app`, with HID idle seconds and the video flag set.
    fn idle_app(bundle: &str, domain: Option<&str>, idle_secs: u64, video: bool) -> Sample {
        let Sample::Front(mut a) = app(bundle, domain) else { unreachable!() };
        a.idle_secs = idle_secs;
        a.video = video;
        Sample::Front(a)
    }

    fn sum_secs(actions: &[Action], away: bool) -> u64 {
        actions
            .iter()
            .filter_map(|a| match (a, away) {
                (Action::Away { secs, .. }, true) | (Action::Focused { secs, .. }, false) => Some(*secs),
                _ => None,
            })
            .sum()
    }

    /// Feed the same sample every 2s from `from` up to and including `to` (ms).
    fn run(m: &mut Machine, c: &GuardConfig, s: &Sample, from: u64, to: u64) -> Vec<Action> {
        let mut out = Vec::new();
        let mut t = from;
        while t <= to {
            out.extend(m.step(c, mode_for(c, false), Some(s), t));
            t += 2000;
        }
        out
    }

    fn opened(actions: &[Action]) -> usize {
        actions.iter().filter(|a| matches!(a, Action::OpenNudge(_))).count()
    }

    // --- video calls ---

    #[test]
    fn meeting_urls_are_meet_rooms_and_the_zoom_web_client() {
        assert!(is_meeting_url("https://meet.google.com/abc-defg-hij"));
        assert!(is_meeting_url("https://meet.google.com/abc-defg-hij?authuser=1"));
        assert!(is_meeting_url(" https://meet.google.com/abc-defg-hij/ "));
        assert!(!is_meeting_url("https://meet.google.com/"), "the Meet home page is not a call");
        assert!(!is_meeting_url("https://meet.google.com/landing"));
        assert!(!is_meeting_url("https://meet.google.com/ab-defg-hij"));
        assert!(!is_meeting_url("https://notmeet.google.com.evil.io/abc-defg-hij"));
        assert!(is_meeting_url("https://app.zoom.us/wc/123456789/join"));
        assert!(is_meeting_url("https://us02web.zoom.us/wc/123456789/start"));
        assert!(!is_meeting_url("https://zoom.us/j/123456789"), "the join page hands off to the app");
        assert!(!is_meeting_url("https://notzoom.us/wc/1"));
        assert!(!is_meeting_url("missing value"));
        assert!(!is_meeting_url(""));
    }

    #[test]
    fn a_call_never_nudges_and_clears_a_nudge_on_screen() {
        let c = cfg();
        let mut m = Machine::default();
        // Off task for well past the grace period, but in a call: nothing opens.
        let mut t = 0;
        while t <= 120_000 {
            assert_eq!(opened(&m.step(&c, Mode::Guard, Some(&Sample::Meeting), t)), 0);
            t += 2000;
        }
        // A real drift nudge, then the call starts: it closes.
        let a = run(&mut m, &c, &app("com.apple.Music", None), 122_000, 160_000);
        assert_eq!(opened(&a), 1);
        assert!(m.nudge().is_some());
        let a = m.step(&c, Mode::Guard, Some(&Sample::Meeting), 162_000);
        assert!(a.contains(&Action::CloseNudge));
        assert!(m.nudge().is_none());
        // After the call the full grace period applies again.
        let a = run(&mut m, &c, &app("com.apple.Music", None), 164_000, 164_000 + 26_000);
        assert_eq!(opened(&a), 0);
    }

    // --- domain matching ---

    #[test]
    fn host_suffix_matching_respects_label_boundaries() {
        assert!(host_matches("github.com", "github.com"));
        assert!(host_matches("gist.github.com", "github.com"));
        assert!(host_matches("GIST.GitHub.com.", "github.com"));
        assert!(!host_matches("notgithub.com", "github.com"));
        assert!(!host_matches("github.com.evil.io", "github.com"));
        assert!(host_matches("www.notion.so", "https://www.notion.so/workspace"));
        assert!(host_matches("app.notion.so", "*.notion.so"));
        assert!(!host_matches("github.com", ""));
    }

    #[test]
    fn normalize_domain_strips_scheme_path_port_and_userinfo() {
        assert_eq!(normalize_domain("https://WWW.GitHub.com/x?y#z").as_deref(), Some("github.com"));
        assert_eq!(normalize_domain("billing.luxvps.net:443").as_deref(), Some("billing.luxvps.net"));
        assert_eq!(normalize_domain("https://user@claude.ai/chat").as_deref(), Some("claude.ai"));
        assert_eq!(normalize_domain("localhost"), None);
        assert_eq!(normalize_domain("   "), None);
    }

    #[test]
    fn url_host_only_for_http_urls() {
        assert_eq!(url_host("https://mail.google.com/mail/u/0/").as_deref(), Some("mail.google.com"));
        assert_eq!(url_host("http://Example.COM:8080/a").as_deref(), Some("example.com"));
        assert_eq!(url_host("chrome://newtab/"), None);
        assert_eq!(url_host("file:///Users/x/a.html"), None);
        assert_eq!(url_host("missing value"), None);
    }

    #[test]
    fn on_task_checks_self_apps_and_domains() {
        let c = cfg();
        let me = FrontApp { bundle_id: None, name: "focusbox".into(), domain: None, is_self: true, ..Default::default() };
        assert!(is_on_task(&c, &me));
        let packaged = FrontApp {
            bundle_id: Some(SELF_BUNDLE_ID.into()),
            name: "Focusbox".into(),
            domain: None,
            is_self: false,
            ..Default::default()
        };
        assert!(is_on_task(&c, &packaged));
        let Sample::Front(code) = app("com.microsoft.vscode", None) else { unreachable!() };
        assert!(is_on_task(&c, &code), "bundle ids compare case-insensitively");
        let Sample::Front(gh) = app("com.google.Chrome", Some("gist.github.com")) else { unreachable!() };
        assert!(is_on_task(&c, &gh));
        let Sample::Front(yt) = app("com.google.Chrome", Some("youtube.com")) else { unreachable!() };
        assert!(!is_on_task(&c, &yt));
        let Sample::Front(unknown) = app("com.google.Chrome", None) else { unreachable!() };
        assert!(!is_on_task(&c, &unknown), "unknown tab = the browser alone");
        let mut c2 = cfg();
        c2.allow_apps.push("com.google.Chrome".into());
        assert!(is_on_task(&c2, &yt), "allowing the browser allows every site in it");
    }

    // --- mode ---

    #[test]
    fn mode_follows_timer_task_and_workday() {
        let mut c = cfg();
        assert_eq!(mode_for(&c, false), Mode::Guard);
        c.timer = TimerState::Paused;
        assert_eq!(mode_for(&c, false), Mode::Idle);
        c.workday.enabled = true;
        assert_eq!(mode_for(&c, false), Mode::Idle, "outside the window a paused timer is idle");
        assert_eq!(mode_for(&c, true), Mode::Guard, "inside the window a paused task is guarded");
        // No on-screen "start a task" prompt any more: inside the window, a card whose
        // timer was never started, or no card at all, is simply idle.
        c.timer = TimerState::Idle;
        assert_eq!(mode_for(&c, true), Mode::Idle);
        c.has_task = false;
        c.timer = TimerState::Running;
        assert_eq!(mode_for(&c, true), Mode::Idle);
        assert_eq!(mode_for(&c, false), Mode::Idle);
        c.enabled = false;
        assert_eq!(mode_for(&c, true), Mode::Idle);
    }

    // --- workday window ---

    fn wd() -> Workday {
        Workday { enabled: true, ..Workday::default() }
    }

    #[test]
    fn workday_window_in_bangkok() {
        // Bangkok is UTC+7, no DST. 2026-10-05 is a Monday.
        let at = |y, mo, d, h, mi| Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap();
        assert!(in_workday(&wd(), at(2026, 10, 5, 3, 0)), "Mon 10:00 local is in");
        assert!(!in_workday(&wd(), at(2026, 10, 5, 2, 59)), "Mon 09:59 local is out");
        assert!(in_workday(&wd(), at(2026, 10, 5, 11, 59)), "Mon 18:59 local is in");
        assert!(!in_workday(&wd(), at(2026, 10, 5, 12, 0)), "Mon 19:00 local is out (end exclusive)");
        assert!(in_workday(&wd(), at(2026, 10, 10, 5, 0)), "Saturday is a workday");
        assert!(!in_workday(&wd(), at(2026, 10, 11, 5, 0)), "Sunday is not");
        // Sunday 23:30 UTC is already Monday 06:30 in Bangkok: out, but because of the hour.
        assert!(!in_workday(&wd(), at(2026, 10, 4, 23, 30)));
        // Saturday 20:00 UTC = Sunday 03:00 local: the local day decides.
        let mut w = wd();
        w.start = "00:00".into();
        w.end = "23:59".into();
        assert!(!in_workday(&w, at(2026, 10, 10, 20, 0)));
    }

    #[test]
    fn workday_disabled_bad_times_and_overnight() {
        let at = Utc.with_ymd_and_hms(2026, 10, 5, 5, 0, 0).unwrap(); // Mon 12:00 BKK
        let mut w = wd();
        w.enabled = false;
        assert!(!in_workday(&w, at));
        let mut w = wd();
        w.start = "nope".into();
        assert!(!in_workday(&w, at));
        let mut w = wd();
        w.start = "22:00".into();
        w.end = "02:00".into();
        assert!(!in_workday(&w, at));
        let late = Utc.with_ymd_and_hms(2026, 10, 5, 16, 0, 0).unwrap(); // Mon 23:00 BKK
        assert!(in_workday(&w, late));
        let mut w = wd();
        w.start = "10:00".into();
        w.end = "10:00".into();
        assert!(!in_workday(&w, at), "an empty window is never in");
    }

    // --- drift state machine ---

    #[test]
    fn drift_fires_after_grace_of_continuous_off_task() {
        let c = cfg();
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        // First sample only starts the clock; 30s of accumulated off-task = 16 samples.
        let a = run(&mut m, &c, &yt, 0, 28_000);
        assert_eq!(opened(&a), 0);
        let a = run(&mut m, &c, &yt, 30_000, 30_000);
        assert_eq!(opened(&a), 1);
        assert_eq!(m.drift_count(), 1);
        match m.nudge() {
            Some(NudgeKind::Drift { app, count: 1 }) => assert_eq!(app.domain.as_deref(), Some("youtube.com")),
            other => panic!("unexpected nudge {other:?}"),
        }
    }

    #[test]
    fn any_on_task_sample_resets_the_counter() {
        let c = cfg();
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        let code = app("com.microsoft.VSCode", None);
        run(&mut m, &c, &yt, 0, 26_000);
        run(&mut m, &c, &code, 28_000, 28_000);
        let a = run(&mut m, &c, &yt, 30_000, 56_000);
        assert_eq!(opened(&a), 0, "the brief return reset the count");
        let a = run(&mut m, &c, &yt, 58_000, 60_000);
        assert_eq!(opened(&a), 1);
    }

    #[test]
    fn locked_screen_pauses_counting_without_resetting() {
        let c = cfg();
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        run(&mut m, &c, &yt, 0, 20_000); // 20s off
        for t in (22_000..=600_000).step_by(2000) {
            assert_eq!(opened(&m.step(&c, Mode::Guard, Some(&Sample::Away), t)), 0);
        }
        // Back from the lock: the first sample after it may add at most MAX_STEP_MS.
        let a = run(&mut m, &c, &yt, 602_000, 602_000);
        assert_eq!(opened(&a), 0);
        let a = run(&mut m, &c, &yt, 604_000, 612_000);
        assert_eq!(opened(&a), 1, "the 20s before the lock still count");
    }

    #[test]
    fn a_long_gap_counts_at_most_one_capped_step() {
        let c = cfg();
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        m.step(&c, Mode::Guard, Some(&yt), 0);
        // The Mac slept for an hour between two samples.
        assert_eq!(opened(&m.step(&c, Mode::Guard, Some(&yt), 3_600_000)), 0);
    }

    #[test]
    fn nudge_freezes_counting_and_resolve_starts_fresh() {
        let c = cfg();
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        run(&mut m, &c, &yt, 0, 30_000);
        assert!(m.nudge().is_some());
        let a = run(&mut m, &c, &yt, 32_000, 200_000);
        assert_eq!(opened(&a), 0, "no second nudge while one is up");
        m.resolve();
        assert!(m.nudge().is_none());
        let a = run(&mut m, &c, &yt, 202_000, 228_000);
        assert_eq!(opened(&a), 0, "resolve restarts the grace period");
        let a = run(&mut m, &c, &yt, 230_000, 230_000);
        assert_eq!(opened(&a), 1);
        assert_eq!(m.drift_count(), 2);
    }

    #[test]
    fn drift_count_is_per_task_session() {
        let mut c = cfg();
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        run(&mut m, &c, &yt, 0, 30_000);
        m.resolve();
        run(&mut m, &c, &yt, 32_000, 62_000);
        assert_eq!(m.drift_count(), 2);
        m.resolve();
        c.task_text = "Write the DMs".into();
        c.task_key = "write the dms".into();
        run(&mut m, &c, &yt, 64_000, 94_000);
        assert_eq!(m.drift_count(), 1, "new task, fresh count");
    }

    #[test]
    fn task_change_closes_an_open_drift_nudge() {
        let mut c = cfg();
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        run(&mut m, &c, &yt, 0, 30_000);
        c.task_key = "other".into();
        let a = m.step(&c, Mode::Guard, Some(&yt), 32_000);
        assert!(a.contains(&Action::CloseNudge));
        assert!(m.nudge().is_none());
    }

    #[test]
    fn going_idle_closes_the_nudge_and_flushes_focused_time() {
        let c = cfg();
        let mut m = Machine::default();
        let code = app("com.microsoft.VSCode", None);
        let a = run(&mut m, &c, &code, 0, 90_000);
        let mins: u64 = a
            .iter()
            .filter_map(|x| match x {
                Action::Focused { secs, .. } => Some(*secs),
                _ => None,
            })
            .sum();
        assert_eq!(mins, 60, "one whole minute logged while on task");
        let a = m.step(&c, Mode::Idle, None, 92_000);
        assert_eq!(
            a,
            vec![Action::Focused { task: "Fix the build".into(), secs: 30 }],
            "the partial minute is flushed when the guard goes idle"
        );
    }

    #[test]
    fn remembers_the_last_on_task_app_but_not_focusbox() {
        let c = cfg();
        let mut m = Machine::default();
        run(&mut m, &c, &app("com.microsoft.VSCode", None), 0, 2000);
        let me = Sample::Front(FrontApp { bundle_id: None, name: "focusbox".into(), domain: None, is_self: true, ..Default::default() });
        run(&mut m, &c, &me, 4000, 6000);
        assert_eq!(m.last_on_task_bundle(), Some("com.microsoft.VSCode"));
    }

    #[test]
    fn workday_mode_never_opens_a_nudge_without_a_running_or_paused_task() {
        // The old "No task running" full-screen prompt is gone: a whole workday with no
        // card, or a card whose timer was never started, opens nothing and logs nothing.
        for (has_task, timer) in [(false, TimerState::Idle), (false, TimerState::Running), (true, TimerState::Idle)] {
            let mut c = cfg();
            c.has_task = has_task;
            c.timer = timer;
            c.workday.enabled = true;
            let mut m = Machine::default();
            let any = app("com.google.Chrome", Some("youtube.com"));
            let mut t = 0;
            while t <= 60 * 60_000 {
                let mode = mode_for(&c, true);
                let a = m.step(&c, mode, if mode == Mode::Idle { None } else { Some(&any) }, t);
                assert!(a.is_empty(), "{has_task} {timer:?}: {a:?}");
                t += 2000;
            }
        }
    }

    #[test]
    fn workday_mode_still_guards_a_paused_task() {
        let mut c = cfg();
        c.timer = TimerState::Paused;
        c.workday.enabled = true;
        let mut m = Machine::default();
        let a = run_in_window(&mut m, &c, &app("com.google.Chrome", Some("youtube.com")), 0, 30_000);
        assert_eq!(opened(&a), 1);
    }

    fn run_in_window(m: &mut Machine, c: &GuardConfig, s: &Sample, from: u64, to: u64) -> Vec<Action> {
        let mut out = Vec::new();
        let mut t = from;
        while t <= to {
            out.extend(m.step(c, mode_for(c, true), Some(s), t));
            t += 2000;
        }
        out
    }

    #[test]
    fn first_drift_is_free_then_every_way_out_needs_a_reason() {
        let off = FrontApp { bundle_id: None, name: "Slack".into(), domain: None, is_self: false, ..Default::default() };
        let first = NudgeKind::Drift { app: off.clone(), count: 1 };
        let repeat = NudgeKind::Drift { app: off, count: 2 };
        for action in ["back", "park", "allow"] {
            assert!(!reason_needed(&first, action), "{action} is free on the first drift");
            assert!(reason_needed(&repeat, action), "{action} needs a reason on a repeat drift");
        }
        assert!(reason_needed(&first, "switch"), "switching always needs a reason");
        assert!(reason_needed(&repeat, "switch"));
    }

    #[test]
    fn repeat_drift_count_reaches_the_escalation_threshold() {
        // End to end through the machine: the second nudge of a task session is the one
        // that demands a reason.
        let c = cfg();
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        run(&mut m, &c, &yt, 0, 30_000);
        let first = m.nudge().cloned().unwrap();
        assert!(!reason_needed(&first, "back"));
        m.resolve();
        run(&mut m, &c, &yt, 32_000, 60_000);
        let second = m.nudge().cloned().unwrap();
        for action in ["back", "park", "allow"] {
            assert!(reason_needed(&second, action));
        }
    }

    fn state_logging_to_tmp(tag: &str) -> (GuardState, PathBuf) {
        let mut dir = std::env::temp_dir();
        dir.push(format!("focusbox-preview-{tag}-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join(LOG_FILE);
        let state = GuardState::default();
        *state.log_path.lock().unwrap() = Some(path.clone());
        (state, path)
    }

    #[test]
    fn a_preview_never_counts_escalates_or_logs() {
        let (state, log) = state_logging_to_tmp("a");
        assert!(state.begin_preview("  Fix the build  ", false));
        {
            let i = state.inner.lock().unwrap();
            assert!(i.machine.nudge().is_none(), "the drift machine never sees a preview");
            assert_eq!(i.machine.drift_count(), 0);
            let p = i.payload().unwrap();
            assert_eq!(p.kind, "preview");
            assert_eq!(p.task, "Fix the build");
            assert_eq!(p.label.as_deref(), Some("Example site"));
            assert!(!p.reason_required);
            assert_eq!(i.wanted(), Some(false), "the preview carries its own blur setting");
        }
        assert!(state.end_preview());
        assert!(!state.end_preview());
        assert!(state.inner.lock().unwrap().payload().is_none());
        assert!(!log.exists(), "nothing was logged");

        // An empty Focus card previews as "Your task".
        assert!(state.begin_preview("", true));
        assert_eq!(state.inner.lock().unwrap().payload().unwrap().task, "Your task");
    }

    #[test]
    fn a_real_drift_wins_over_a_preview() {
        let (state, _) = state_logging_to_tmp("b");
        let c = cfg();
        assert!(state.begin_preview("Fix the build", true));
        {
            let mut i = state.inner.lock().unwrap();
            i.cfg = c.clone();
            let yt = app("com.google.Chrome", Some("youtube.com"));
            run(&mut i.machine, &c, &yt, 0, 30_000);
            assert_eq!(i.machine.drift_count(), 1, "a preview doesn't add to the count either");
            assert_eq!(i.payload().unwrap().kind, "drift", "the real nudge replaces the preview");
            assert_eq!(i.wanted(), Some(c.blur));
        }
        assert!(!state.begin_preview("x", false), "no preview while a real nudge is up");
        assert_eq!(state.inner.lock().unwrap().payload().unwrap().kind, "drift");
    }

    // --- idle / away ---

    #[test]
    fn idle_off_task_pauses_the_drift_count_and_resumes_it() {
        let c = cfg(); // idle_after_secs = 180
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        run(&mut m, &c, &yt, 0, 20_000); // 20s off task
        let gone = idle_app("com.google.Chrome", Some("youtube.com"), 200, false);
        let a = run(&mut m, &c, &gone, 22_000, 600_000);
        assert_eq!(opened(&a), 0, "no nudge while away");
        assert_eq!(sum_secs(&a, false), 0, "no focused time while away");
        assert!(sum_secs(&a, true) >= 9 * 60, "away time is logged per minute");
        assert_eq!(m.drift_count(), 0);
        // Back: the 20s from before still count, 10s more is enough.
        let a = run(&mut m, &c, &yt, 602_000, 608_000);
        assert_eq!(opened(&a), 0);
        let a = run(&mut m, &c, &yt, 610_000, 610_000);
        assert_eq!(opened(&a), 1, "counting resumed from the paused value");
    }

    #[test]
    fn under_the_idle_threshold_is_not_away() {
        let c = cfg();
        let mut m = Machine::default();
        let quiet = idle_app("com.google.Chrome", Some("youtube.com"), 179, false);
        let a = run(&mut m, &c, &quiet, 0, 30_000);
        assert_eq!(opened(&a), 1);
    }

    #[test]
    fn a_video_in_front_is_still_drift_when_idle() {
        let c = cfg();
        let mut m = Machine::default();
        let watching = idle_app("com.google.Chrome", Some("youtube.com"), 900, true);
        let a = run(&mut m, &c, &watching, 0, 30_000);
        assert_eq!(opened(&a), 1, "passive YouTube is drift");
        assert_eq!(sum_secs(&a, true), 0);
    }

    #[test]
    fn on_task_quiet_time_is_focused_up_to_fifteen_minutes() {
        let c = cfg();
        let mut m = Machine::default();
        let reading = idle_app("com.microsoft.VSCode", None, 14 * 60, false);
        let a = run(&mut m, &c, &reading, 0, 120_000);
        assert_eq!(sum_secs(&a, false), 120, "waiting on an agent counts as focused");
        assert_eq!(sum_secs(&a, true), 0);
        let gone = idle_app("com.microsoft.VSCode", None, 15 * 60, false);
        let a = run(&mut m, &c, &gone, 122_000, 242_000);
        assert_eq!(sum_secs(&a, false), 0, "past 15 minutes it stops counting");
        assert!(sum_secs(&a, true) >= 60);
        let video_doesnt_matter = idle_app("com.microsoft.VSCode", None, 16 * 60, true);
        let a = run(&mut m, &c, &video_doesnt_matter, 244_000, 364_000);
        assert_eq!(sum_secs(&a, false), 0);
    }

    #[test]
    fn walking_away_does_not_close_an_open_drift_nudge() {
        let c = cfg();
        let mut m = Machine::default();
        run(&mut m, &c, &app("com.google.Chrome", Some("youtube.com")), 0, 30_000);
        assert!(m.nudge().is_some());
        let gone = idle_app("com.google.Chrome", Some("youtube.com"), 3600, false);
        let a = run(&mut m, &c, &gone, 32_000, 900_000);
        assert!(!a.contains(&Action::CloseNudge));
        assert!(m.nudge().is_some());
        assert_eq!(sum_secs(&a, true), 0, "the nudge freezes away time too");
    }

    #[test]
    fn partial_away_time_is_flushed_when_the_guard_goes_idle() {
        let c = cfg();
        let mut m = Machine::default();
        let gone = idle_app("com.google.Chrome", None, 600, false);
        run(&mut m, &c, &gone, 0, 90_000);
        let a = m.step(&c, Mode::Idle, None, 92_000);
        assert_eq!(a, vec![Action::Away { task: "Fix the build".into(), secs: 30 }]);
    }

    // --- monitor choice ---

    /// A physical-pixel monitor as tao reports it on macOS: CG origin and point size,
    /// each multiplied by the monitor's own scale.
    fn mon(x_pt: f64, y_pt: f64, w_pt: f64, h_pt: f64, scale: f64) -> Rect {
        monitor_points(
            ((x_pt * scale) as i32, (y_pt * scale) as i32),
            ((w_pt * scale) as u32, (h_pt * scale) as u32),
            scale,
        )
    }

    fn win(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn monitor_points_undoes_each_monitors_own_scale() {
        assert_eq!(monitor_points((2880, 0), (3840, 2160), 2.0), win(1440.0, 0.0, 1920.0, 1080.0));
        assert_eq!(monitor_points((-1920, 0), (1920, 1080), 1.0), win(-1920.0, 0.0, 1920.0, 1080.0));
        assert_eq!(monitor_points((10, 10), (100, 100), 0.0), win(10.0, 10.0, 100.0, 100.0), "bad scale = 1");
    }

    #[test]
    fn picks_the_monitor_holding_the_window_centre() {
        // Retina laptop as primary (scale 2), a 1x display to its right.
        let mons = [mon(0.0, 0.0, 1512.0, 982.0, 2.0), mon(1512.0, 0.0, 2560.0, 1440.0, 1.0)];
        assert_eq!(pick_monitor(win(100.0, 50.0, 800.0, 600.0), &mons), Some(0));
        assert_eq!(pick_monitor(win(1800.0, 200.0, 1200.0, 900.0), &mons), Some(1));
        // Straddling the edge: the centre decides.
        assert_eq!(pick_monitor(win(1200.0, 100.0, 800.0, 600.0), &mons), Some(1));
    }

    #[test]
    fn secondary_left_of_and_above_the_primary_use_negative_coordinates() {
        // Primary 1x at the origin, a retina display to the LEFT, another display ABOVE.
        let mons = [
            mon(0.0, 0.0, 1920.0, 1080.0, 1.0),
            mon(-1728.0, 0.0, 1728.0, 1117.0, 2.0),
            mon(0.0, -1440.0, 2560.0, 1440.0, 1.0),
        ];
        assert_eq!(pick_monitor(win(-1500.0, 100.0, 900.0, 700.0), &mons), Some(1));
        assert_eq!(pick_monitor(win(400.0, -1200.0, 1000.0, 800.0), &mons), Some(2));
        assert_eq!(pick_monitor(win(300.0, 200.0, 900.0, 600.0), &mons), Some(0));
    }

    #[test]
    fn falls_back_to_largest_overlap_then_none() {
        let mons = [mon(0.0, 0.0, 1000.0, 800.0, 1.0), mon(1000.0, 0.0, 1000.0, 800.0, 2.0)];
        // Centre is below both screens; more of it is on the right one.
        assert_eq!(pick_monitor(win(700.0, 700.0, 1000.0, 400.0), &mons), Some(1));
        // Entirely off-screen.
        assert_eq!(pick_monitor(win(5000.0, 5000.0, 100.0, 100.0), &mons), None);
        assert_eq!(pick_monitor(win(0.0, 0.0, 10.0, 10.0), &[]), None);
    }

    // --- pause ---

    #[test]
    fn a_pause_suppresses_drift_and_resumes_by_itself() {
        let mut c = cfg();
        c.paused_until = 1_000_000; // epoch ms
        let epoch = 900_000; // "now" when the loop starts: paused for another 100s
        let mut m = Machine::default();
        let yt = app("com.google.Chrome", Some("youtube.com"));
        let mut opened_at = None;
        let mut logged = 0;
        let mut t = 0;
        while t <= 200_000 && opened_at.is_none() {
            let mode = effective_mode(&c, false, epoch + t);
            let a = m.step(&c, mode, if mode == Mode::Idle { None } else { Some(&yt) }, t);
            logged += a.iter().filter(|x| matches!(x, Action::Focused { .. } | Action::Away { .. })).count();
            if opened(&a) > 0 {
                opened_at = Some(t);
            }
            t += 2000;
        }
        assert_eq!(logged, 0, "nothing is counted while paused");
        let at = opened_at.expect("the guard came back on its own");
        // The pause ends at t=100s; the grace period (30s, the first sample counting its
        // 2s step) runs from there.
        assert!(at >= 100_000 + 28_000, "no drift during the pause ({at})");
        assert!(at <= 100_000 + 32_000, "it resumed by itself ({at})");
    }

    #[test]
    fn removing_an_allow_from_the_nudge_in_settings_takes_effect() {
        let mut inner = Inner::default();
        let base = cfg(); // allows VS Code + github.com only
        inner.apply_config(base.clone(), 0);
        let Sample::Front(slack) = app("com.tinyspeck.slackmacgap", None) else { unreachable!() };
        assert!(!is_on_task(&inner.effective_cfg(), &slack));

        // "Allow Slack for this task" on the nudge: on task immediately.
        inner.allow_for_task(&base.task_key, Some("com.tinyspeck.slackmacgap"), None);
        assert!(is_on_task(&inner.effective_cfg(), &slack));

        // A push that raced the allow (doesn't carry it yet) must not lose it.
        inner.apply_config(base.clone(), 0);
        assert!(is_on_task(&inner.effective_cfg(), &slack));

        // The main window persisted it and pushes it (bundle id case differs: still a match).
        let mut with = base.clone();
        with.allow_apps.push("COM.TINYSPECK.SLACKMACGAP".into());
        inner.apply_config(with, 0);
        assert!(is_on_task(&inner.effective_cfg(), &slack));
        assert!(!inner.session_allow.contains_key(&base.task_key), "handed over to the main window's list");

        // Removed in Settings: the next push no longer carries it, and it's gone.
        inner.apply_config(base.clone(), 0);
        assert!(!is_on_task(&inner.effective_cfg(), &slack));
    }

    #[test]
    fn a_pause_restored_at_launch_is_not_logged_again() {
        let now = 1_000_000;
        let mut inner = Inner::default();
        let mut c = cfg();
        c.paused_until = now + 10 * 60_000;
        // First push of the run: restoring a pause that started before the restart.
        let first = inner.apply_config(c.clone(), now);
        assert_eq!(first.pause_started, None);
        assert_eq!(effective_mode(&inner.cfg, false, now), Mode::Idle, "but it is honoured");
        // The same pause pushed again: nothing new.
        assert_eq!(inner.apply_config(c.clone(), now + 1000).pause_started, None);
        // Resume, then a real new pause: logged.
        c.paused_until = 0;
        inner.apply_config(c.clone(), now + 2000);
        c.paused_until = now + 2000 + 15 * 60_000;
        assert_eq!(inner.apply_config(c, now + 2000).pause_started, Some(900));
    }

    #[test]
    fn pausing_closes_an_open_nudge_but_the_first_push_never_does() {
        let mut inner = Inner::default();
        let c = cfg();
        inner.apply_config(c.clone(), 0);
        run(&mut inner.machine, &c, &app("com.google.Chrome", Some("youtube.com")), 0, 30_000);
        assert!(inner.machine.nudge().is_some());
        let mut p = c.clone();
        p.paused_until = 1_000_000;
        let applied = inner.apply_config(p, 1000);
        assert!(applied.closed_nudge);
        assert!(inner.machine.nudge().is_none());
    }

    // --- window lifecycle: show/hide, never destroy ---

    #[test]
    fn the_first_nudge_creates_the_window_hidden_then_shows_it() {
        use WinOp::*;
        assert_eq!(plan_nudge_present(false, false, false, true), vec![Create, Blur(true), Show, Raise, Focus]);
        assert_eq!(plan_nudge_present(false, false, false, false), vec![Create, Blur(false), Show, Raise, Focus]);
    }

    #[test]
    fn later_nudges_reuse_the_hidden_window() {
        use WinOp::*;
        // Same monitor as last time: no move, just refresh the page and show.
        assert_eq!(plan_nudge_present(true, false, false, false), vec![Blur(false), Refresh, Show, Raise, Focus]);
        // Another monitor: placed while still hidden.
        assert_eq!(plan_nudge_present(true, false, true, true), vec![Place, Blur(true), Refresh, Show, Raise, Focus]);
    }

    #[test]
    fn a_visible_window_is_hidden_before_it_moves() {
        use WinOp::*;
        // e.g. a preview on one screen becoming a real nudge for the other screen.
        let ops = plan_nudge_present(true, true, true, false);
        assert_eq!(ops, vec![Hide, Place, Blur(false), Refresh, Show, Raise, Focus]);
        // Preview -> real nudge on the same screen: no move, but still hidden while the
        // content changes.
        assert_eq!(plan_nudge_present(true, true, false, true), vec![Hide, Blur(true), Refresh, Show, Raise, Focus]);
    }

    #[test]
    fn the_blur_setting_is_applied_on_every_show_and_nothing_is_ever_destroyed() {
        for exists in [false, true] {
            for visible in [false, true] {
                for moved in [false, true] {
                    for blur in [false, true] {
                        let ops = plan_nudge_present(exists, visible, moved, blur);
                        assert!(ops.contains(&WinOp::Blur(blur)));
                        assert_eq!(ops.iter().filter(|o| **o == WinOp::Create).count(), usize::from(!exists));
                        if let (Some(p), Some(h)) = (
                            ops.iter().position(|o| *o == WinOp::Place),
                            ops.iter().position(|o| *o == WinOp::Show),
                        ) {
                            assert!(p < h, "never moved after showing");
                        }
                        if exists && visible {
                            assert_eq!(ops[0], WinOp::Hide, "hidden before it moves or changes");
                        }
                    }
                }
            }
        }
        assert_eq!(plan_nudge_dismiss(true), vec![WinOp::Hide, WinOp::Reset]);
        assert!(plan_nudge_dismiss(false).is_empty());
    }

    #[test]
    fn effective_mode_is_idle_only_until_the_pause_ends() {
        let mut c = cfg();
        c.paused_until = 5_000;
        assert_eq!(effective_mode(&c, false, 4_999), Mode::Idle);
        assert_eq!(effective_mode(&c, false, 5_000), Mode::Guard);
        c.paused_until = 0;
        assert_eq!(effective_mode(&c, false, 1), Mode::Guard);
        c.workday.enabled = true;
        c.timer = TimerState::Paused;
        c.paused_until = 10;
        assert_eq!(effective_mode(&c, true, 5), Mode::Idle, "the workday guard pauses too");
        assert_eq!(effective_mode(&c, true, 10), Mode::Guard);
    }

    #[test]
    fn pause_start_detection() {
        assert_eq!(pause_started(0, 61_000, 1_000), Some(60), "new pause");
        assert_eq!(pause_started(61_000, 61_000, 2_000), None, "same pause pushed again");
        assert_eq!(pause_started(61_000, 121_000, 2_000), Some(119), "extended");
        assert_eq!(pause_started(61_000, 0, 2_000), None, "resume");
        assert_eq!(pause_started(0, 500, 1_000), None, "already over");
        assert_eq!(pause_started(500, 61_000, 1_000), Some(60), "an expired pause doesn't count");
    }

    #[test]
    fn reasons_need_ten_trimmed_characters() {
        assert!(!valid_reason(None));
        assert!(!valid_reason(Some("   short   ")));
        assert!(!valid_reason(Some("123456789")));
        assert!(valid_reason(Some("  1234567890  ")));
        assert!(valid_reason(Some("éééééééééé")), "counted in characters, not bytes");
    }

    // --- log ---

    #[test]
    fn prune_keeps_recent_entries_and_drops_garbage() {
        let e = |ts| serde_json::to_string(&LogEntry {
            ts,
            kind: "drift".into(),
            task: "t".into(),
            app: Some("Chrome".into()),
            domain: None,
            reason: None,
            text: None,
            secs: None,
        })
        .unwrap();
        let content = format!("{}\n{}\nnot json\n\n{}\n", e(10), e(500), e(1000));
        let (kept, dropped) = prune_log(&content, 100);
        assert!(dropped);
        assert_eq!(kept, format!("{}\n{}\n", e(500), e(1000)));
        let (again, dropped) = prune_log(&kept, 100);
        assert!(!dropped);
        assert_eq!(again, kept);
    }

    #[test]
    fn log_round_trips_through_the_file() {
        let mut dir = std::env::temp_dir();
        dir.push(format!("focusbox-guardlog-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join(LOG_FILE);
        let entry = LogEntry {
            ts: 1234,
            kind: "switch".into(),
            task: "Fix the build".into(),
            app: Some("Google Chrome".into()),
            domain: Some("youtube.com".into()),
            reason: Some("customer emergency call".into()),
            text: None,
            secs: None,
        };
        append_log(&path, &entry);
        append_log(&path, &LogEntry { ts: 5, ..entry.clone() });
        assert_eq!(read_log_since(&path, 1000), vec![entry]);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("\"secs\""), "absent fields are omitted");
    }

    #[test]
    fn config_deserializes_from_the_frontend_shape_with_defaults() {
        let c: GuardConfig = serde_json::from_str(
            r#"{"enabled":true,"hasTask":true,"taskText":"x","taskKey":"x","timer":"paused",
                "allowApps":["a"],"allowDomains":["b.com"],"graceSecs":60,
                "workday":{"enabled":true,"start":"09:00","end":"17:00","days":[1,2],"tz":"Europe/Berlin"}}"#,
        )
        .unwrap();
        assert_eq!(c.timer, TimerState::Paused);
        assert_eq!(c.grace_secs, 60);
        assert_eq!(c.workday.tz, "Europe/Berlin");
        let d: GuardConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(d, GuardConfig::default());
        assert_eq!(d.grace_secs, 30);
        assert_eq!(d.workday.days, vec![1, 2, 3, 4, 5, 6]);
    }
}
