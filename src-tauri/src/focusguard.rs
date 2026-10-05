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
/// Focused time is logged in whole minutes while on task.
const FOCUSED_CHUNK_MS: u64 = 60_000;
/// Whole-workday mode: first "pick a task" nudge after this long without one...
const NEED_TASK_FIRST_MS: u64 = 2 * 60_000;
/// ...then again this long after each dismissal.
const NEED_TASK_REPEAT_MS: u64 = 10 * 60_000;
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
            blur: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Nothing to watch.
    Idle,
    /// A task is active: count off-task time.
    Guard,
    /// Whole-workday mode, inside the window, no task running: prompt to pick one.
    NeedTask,
}

/// The guard's mode for a config and whether "now" is inside the workday window.
///
/// - Off: idle.
/// - A Focus task with the timer running: guard.
/// - Inside the workday window: a Focus task with the timer paused is still guarded; no
///   task, or a task whose timer was never started (or has finished), is "need task".
/// - Outside the window, anything short of a running timer is idle.
pub fn mode_for(cfg: &GuardConfig, in_window: bool) -> Mode {
    if !cfg.enabled {
        return Mode::Idle;
    }
    if cfg.has_task && cfg.timer == TimerState::Running {
        return Mode::Guard;
    }
    if cfg.workday.enabled && in_window {
        if cfg.has_task && cfg.timer == TimerState::Paused {
            return Mode::Guard;
        }
        return Mode::NeedTask;
    }
    Mode::Idle
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrontApp {
    pub bundle_id: Option<String>,
    pub name: String,
    /// Active tab host, only for a supported browser whose tab could be read.
    pub domain: Option<String>,
    /// The frontmost process is this one (covers the dev build, which has no bundle id).
    pub is_self: bool,
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
    Front(FrontApp),
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
    NeedTask,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    OpenNudge(NudgeKind),
    CloseNudge,
    /// Seconds of on-task time to log against `task`.
    Focused { task: String, secs: u64 },
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
    need_ms: u64,
    need_threshold_ms: u64,
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
            need_ms: 0,
            need_threshold_ms: NEED_TASK_FIRST_MS,
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
            let keep = matches!(
                (&self.nudge, mode),
                (Some(NudgeKind::Drift { .. }), Mode::Guard) | (Some(NudgeKind::NeedTask), Mode::NeedTask)
            );
            if self.nudge.is_some() && !keep {
                self.nudge = None;
                out.push(Action::CloseNudge);
            }
            self.off_ms = 0;
            if mode == Mode::NeedTask {
                self.need_ms = 0;
                self.need_threshold_ms = NEED_TASK_FIRST_MS;
            }
            self.mode = mode;
        }

        match (mode, sample) {
            (Mode::Idle, _) | (_, None) | (_, Some(Sample::Away)) => {}
            (Mode::Guard, Some(Sample::Front(app))) => {
                // Frozen while a nudge is up: it is resolved by the user, not by time.
                if self.nudge.is_some() {
                    return out;
                }
                if is_on_task(cfg, app) {
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
            (Mode::NeedTask, Some(Sample::Front(_))) => {
                if self.nudge.is_none() {
                    self.need_ms += dt;
                    if self.need_ms >= self.need_threshold_ms {
                        self.need_ms = 0;
                        self.nudge = Some(NudgeKind::NeedTask);
                        out.push(Action::OpenNudge(NudgeKind::NeedTask));
                    }
                }
            }
        }
        out
    }

    /// The user answered the nudge. Counting starts fresh; a "pick a task" prompt comes
    /// back after the repeat interval if there is still no task.
    pub fn resolve(&mut self) {
        self.nudge = None;
        self.off_ms = 0;
        self.need_ms = 0;
        self.need_threshold_ms = NEED_TASK_REPEAT_MS;
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
        NudgeKind::NeedTask => false,
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
    use super::{url_host, FrontApp, Sample, AWAY_BUNDLES, BROWSERS};
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

    /// The frontmost app, plus the active tab's host for a supported browser.
    /// NSWorkspace needs no permission; the browser read needs Automation consent once.
    ///
    /// Runs inside its own autorelease pool: the watcher thread never exits, so anything
    /// AppKit autoreleases here would otherwise pile up for the life of the process.
    pub fn sample() -> Sample {
        objc2::rc::autoreleasepool(|_| sample_inner())
    }

    fn sample_inner() -> Sample {
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
        let is_self = app.processIdentifier() == std::process::id() as i32;
        let domain = match &bundle_id {
            Some(b) if !is_self => BROWSERS
                .iter()
                .find(|(id, _)| id == b)
                .and_then(|(_, script)| osascript(script))
                .and_then(|u| url_host(&u)),
            _ => None,
        };
        Sample::Front(FrontApp { bundle_id, name, domain, is_self })
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

    pub fn sample() -> Sample {
        Sample::Away
    }
    pub fn activate_bundle(_bundle: &str) -> bool {
        false
    }
    pub fn activate_self() {}
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
    /// "drift" | "needTask"
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
    /// Whether the nudge window currently on screen was built with the blur effect, so a
    /// mismatch can be rebuilt (macOS can't remove a vibrancy view from a live window).
    window_blur: Option<bool>,
}

#[derive(Clone, Debug)]
struct Preview {
    payload: NudgePayload,
    blur: bool,
}

impl Inner {
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
            NudgeKind::NeedTask => Some(NudgePayload {
                kind: "needTask".into(),
                task: String::new(),
                label: None,
                app_name: None,
                domain: None,
                drift_count: 0,
                reason_required: false,
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
            let mode = mode_for(&cfg, in_workday(&cfg.workday, Utc::now()));
            (cfg, mode)
        };
        // Sample outside the lock: the browser read can take up to 1.5s.
        let nudge_up = state.inner.lock().map(|i| i.machine.nudge().is_some()).unwrap_or(false);
        // A nudge is only answered through its buttons. If its window went away some other
        // way (Cmd+W, a crash in the webview), put it back rather than staying frozen.
        if nudge_up && app.get_webview_window(NUDGE_LABEL).is_none() {
            open_nudge_window(&app);
        }
        let sample = if mode == Mode::Idle || nudge_up { None } else { Some(platform::sample()) };
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
                    if let NudgeKind::Drift { app: off, .. } = &kind {
                        state.log_kind("drift", &cfg.task_text, Some(off), None);
                    }
                    open_nudge_window(&app);
                }
                Action::CloseNudge => close_nudge_window(&app),
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

fn open_nudge_window<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let app = handle;
        // Re-check on the main thread: the nudge may have been answered between the
        // caller's decision and now, and an orphan full-screen window has no way out.
        let state = app.state::<Arc<GuardState>>().inner().clone();
        let Some((blur, built_with)) =
            state.inner.lock().ok().and_then(|i| i.wanted().map(|b| (b, i.window_blur)))
        else {
            return;
        };
        if let Some(w) = app.get_webview_window(NUDGE_LABEL) {
            if cfg!(target_os = "macos") && built_with != Some(blur) {
                // The blur setting differs from the window on screen, and a vibrancy view
                // can't be removed from a live NSWindow: rebuild once the old one is gone.
                if let Ok(mut i) = state.inner.lock() {
                    i.window_blur = None;
                }
                let _ = w.destroy();
                let later = app.clone();
                std::thread::spawn(move || {
                    for _ in 0..30 {
                        std::thread::sleep(Duration::from_millis(100));
                        if later.get_webview_window(NUDGE_LABEL).is_none() {
                            open_nudge_window(&later);
                            return;
                        }
                    }
                });
                return;
            }
            let _ = w.emit_to(NUDGE_LABEL, "guard://nudge-refresh", ());
            let _ = w.show();
            if let Ok(ns) = w.ns_window_ptr() {
                unsafe { platform::raise_window(ns) };
            }
            platform::activate_self();
            let _ = w.set_focus();
            return;
        }
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());
        let mut builder = tauri::WebviewWindowBuilder::new(
            &app,
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
        .focused(true);
        // Translucent on macOS: the desktop shows through, blurred by an NSVisualEffectView
        // (FullScreenUI follows the system light/dark appearance), and the page paints a
        // theme tint over it (styles.css, .nudge). A solid sheet was a flashbang at night.
        // Needs the macos-private-api feature + app.macOSPrivateApi. Windows has no nudge.
        // The blur is the user's "Blur behind nudge" setting.
        #[cfg(target_os = "macos")]
        {
            use tauri::window::{Effect, EffectState, EffectsBuilder};
            builder = builder.transparent(true);
            if blur {
                builder = builder.effects(
                    EffectsBuilder::new()
                        .effect(Effect::FullScreenUI)
                        .state(EffectState::Active)
                        .build(),
                );
            }
        }
        match &monitor {
            Some(m) => {
                let scale = m.scale_factor();
                let pos = m.position().to_logical::<f64>(scale);
                let size = m.size().to_logical::<f64>(scale);
                builder = builder.position(pos.x, pos.y).inner_size(size.width, size.height);
            }
            None => builder = builder.maximized(true),
        }
        match builder.build() {
            Ok(w) => {
                if let Ok(mut i) = state.inner.lock() {
                    i.window_blur = Some(blur);
                }
                if let Ok(ns) = w.ns_window_ptr() {
                    unsafe { platform::raise_window(ns) };
                }
                platform::activate_self();
                let _ = w.set_focus();
            }
            Err(e) => eprintln!("Focusbox: could not open the focus nudge: {e}"),
        }
    });
}

fn close_nudge_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(NUDGE_LABEL) {
        let _ = w.destroy();
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
pub fn guard_set_config(state: State<'_, Arc<GuardState>>, config: GuardConfig) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "guard state poisoned".to_string())?;
    inner.cfg = GuardConfig {
        task_text: clip(&config.task_text),
        task_key: clip(&config.task_key),
        grace_secs: config.grace_secs.clamp(5, 3600),
        ..config
    };
    Ok(())
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
/// - `open_main` / `snooze`: answers to the workday "pick a task" nudge.
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
            result = crate::todoist::park_text(&app, &what).await?;
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
                let entry = inner.session_allow.entry(task_key.clone()).or_default();
                if let Some(a) = &allow_app {
                    entry.0.insert(a.clone());
                }
                if let Some(d) = &allow_domain {
                    entry.1.insert(d.clone());
                }
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
        (NudgeKind::NeedTask, "open_main") => {
            finish(&state, &app);
            let _ = app.emit_to("main", "guard://open-main", ());
            show_main(&app);
        }
        (NudgeKind::NeedTask, "snooze") => finish(&state, &app),
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
        }
    }

    fn app(bundle: &str, domain: Option<&str>) -> Sample {
        Sample::Front(FrontApp {
            bundle_id: Some(bundle.into()),
            name: bundle.rsplit('.').next().unwrap().into(),
            domain: domain.map(str::to_string),
            is_self: false,
        })
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
        let me = FrontApp { bundle_id: None, name: "focusbox".into(), domain: None, is_self: true };
        assert!(is_on_task(&c, &me));
        let packaged = FrontApp {
            bundle_id: Some(SELF_BUNDLE_ID.into()),
            name: "Focusbox".into(),
            domain: None,
            is_self: false,
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
        c.timer = TimerState::Idle;
        assert_eq!(mode_for(&c, true), Mode::NeedTask);
        c.has_task = false;
        c.timer = TimerState::Running;
        assert_eq!(mode_for(&c, true), Mode::NeedTask);
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
            assert!(m.step(&c, Mode::Guard, Some(&Sample::Away), t).is_empty());
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
        let me = Sample::Front(FrontApp { bundle_id: None, name: "focusbox".into(), domain: None, is_self: true });
        run(&mut m, &c, &me, 4000, 6000);
        assert_eq!(m.last_on_task_bundle(), Some("com.microsoft.VSCode"));
    }

    #[test]
    fn need_task_prompts_after_two_minutes_then_every_ten() {
        let mut c = cfg();
        c.has_task = false;
        c.timer = TimerState::Idle;
        c.workday.enabled = true;
        let mut m = Machine::default();
        let any = app("com.google.Chrome", Some("youtube.com"));
        let mut opened_at = Vec::new();
        let mut t = 0;
        while t <= 30 * 60_000 {
            let a = m.step(&c, mode_for(&c, true), Some(&any), t);
            if opened(&a) > 0 {
                opened_at.push(t);
                m.resolve(); // "Not now"
            }
            t += 2000;
        }
        assert_eq!(opened_at, vec![120_000, 720_000, 1_320_000]);
    }

    #[test]
    fn starting_a_task_closes_the_need_task_nudge() {
        let mut c = cfg();
        c.has_task = false;
        c.workday.enabled = true;
        let mut m = Machine::default();
        let any = app("com.google.Chrome", Some("youtube.com"));
        let mut t = 0;
        while m.nudge().is_none() {
            m.step(&c, mode_for(&c, true), Some(&any), t);
            t += 2000;
        }
        c.has_task = true;
        let a = m.step(&c, mode_for(&c, true), Some(&any), t);
        assert!(a.contains(&Action::CloseNudge));
    }

    #[test]
    fn first_drift_is_free_then_every_way_out_needs_a_reason() {
        let off = FrontApp { bundle_id: None, name: "Slack".into(), domain: None, is_self: false };
        let first = NudgeKind::Drift { app: off.clone(), count: 1 };
        let repeat = NudgeKind::Drift { app: off, count: 2 };
        for action in ["back", "park", "allow"] {
            assert!(!reason_needed(&first, action), "{action} is free on the first drift");
            assert!(reason_needed(&repeat, action), "{action} needs a reason on a repeat drift");
        }
        assert!(reason_needed(&first, "switch"), "switching always needs a reason");
        assert!(reason_needed(&repeat, "switch"));
        assert!(!reason_needed(&NudgeKind::NeedTask, "open_main"));
        assert!(!reason_needed(&NudgeKind::NeedTask, "snooze"));
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
