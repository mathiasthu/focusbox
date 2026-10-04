//! Parking tasks in Todoist.
//!
//! All Todoist traffic goes through here. The webview never talks to api.todoist.com: its
//! CSP doesn't allow it (and `npm run check:csp` would fail the build if the bundle tried),
//! and the API token never crosses back into JS. The token lives in the OS credential store
//! (macOS Keychain / Windows Credential Manager).
//!
//! Parked items go through a small persistent queue (`todoist-queue.json` in the app data
//! dir, written atomically like `focusbox.json`) so a park made offline isn't lost. Each
//! item carries its own UUID, sent as `X-Request-Id` so a retry after an ambiguous failure
//! (request reached Todoist, response didn't reach us) doesn't create a duplicate.
//!
//! Outcome rules, all in the pure [`QueueState`] so they're unit-tested:
//! - 2xx: done, drop the item.
//! - 401/403: keep everything and stop trying until the token changes.
//! - 429, 5xx, network failure: keep, retry later (a 60s loop, plus every new park).
//! - any other 4xx: the request itself is bad and will never succeed; drop and log it.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_http::reqwest;

const QUEUE_FILE: &str = "todoist-queue.json";
const TASKS_URL: &str = "https://api.todoist.com/api/v1/tasks";
const VALIDATE_URL: &str = "https://api.todoist.com/api/v1/projects?limit=1";
const KEYRING_SERVICE: &str = "com.mathiass.focusbox.todoist";
const KEYRING_USER: &str = "api-token";
const PARK_LABEL: &str = "parked";
const RETRY_EVERY: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_TEXT_CHARS: usize = 500;

// ---------------------------------------------------------------------------------------
// The queue (pure)
// ---------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QueueItem {
    pub id: String,
    pub text: String,
    /// Unix epoch milliseconds.
    pub created_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendResult {
    /// 2xx.
    Sent,
    /// 401/403: the token is wrong or revoked.
    Unauthorized,
    /// 429, 5xx, or no response at all.
    Retry,
    /// Any other 4xx: this request will never succeed.
    Rejected,
}

impl SendResult {
    pub fn from_status(status: u16) -> Self {
        match status {
            200..=299 => SendResult::Sent,
            401 | 403 => SendResult::Unauthorized,
            429 => SendResult::Retry,
            400..=499 => SendResult::Rejected,
            _ => SendResult::Retry,
        }
    }
}

#[derive(Default, Debug)]
pub struct QueueState {
    pub items: Vec<QueueItem>,
    /// Set by a 401/403; cleared only when the token changes.
    pub auth_blocked: bool,
    /// Items a sender has claimed and not yet reported back on. A fresh park sends its own
    /// item directly while the retry loop may be working through the backlog; claiming
    /// first means the two can never send the same item at once.
    pub in_flight: HashSet<String>,
}

impl QueueState {
    pub fn enqueue(&mut self, id: String, text: String, created_at: u64) {
        self.items.push(QueueItem { id, text, created_at });
    }

    /// What may be sent now, oldest first. Nothing while blocked on auth; never an item
    /// another sender has claimed.
    pub fn pending(&self) -> Vec<QueueItem> {
        if self.auth_blocked {
            Vec::new()
        } else {
            self.items.iter().filter(|i| !self.in_flight.contains(&i.id)).cloned().collect()
        }
    }

    /// Claim an item for sending. False if it is gone, already claimed, or sending is
    /// blocked on auth.
    pub fn begin(&mut self, id: &str) -> bool {
        if self.auth_blocked || !self.items.iter().any(|i| i.id == id) {
            return false;
        }
        self.in_flight.insert(id.to_string())
    }

    /// Record one send's outcome. Returns whether the batch should go on to the next item:
    /// a failed network or a bad token will fail the rest the same way.
    pub fn apply(&mut self, id: &str, result: SendResult) -> bool {
        self.in_flight.remove(id);
        match result {
            SendResult::Sent => {
                self.items.retain(|i| i.id != id);
                true
            }
            SendResult::Rejected => {
                if let Some(i) = self.items.iter().find(|i| i.id == id) {
                    eprintln!("Focusbox: Todoist rejected a parked item, dropping it: {:?}", i.text);
                }
                self.items.retain(|i| i.id != id);
                true
            }
            SendResult::Unauthorized => {
                self.auth_blocked = true;
                false
            }
            SendResult::Retry => false,
        }
    }

    pub fn token_changed(&mut self) {
        self.auth_blocked = false;
    }
}

/// One pass over the queue with a synchronous sender. The async flush below follows the
/// same pending/apply rules; this is the shape the tests drive with a fake sender.
#[cfg(test)]
pub fn drain_with<F: FnMut(&QueueItem) -> SendResult>(state: &mut QueueState, mut send: F) -> Vec<(String, SendResult)> {
    let mut outcomes = Vec::new();
    for item in state.pending() {
        if !state.begin(&item.id) {
            continue;
        }
        let r = send(&item);
        outcomes.push((item.id.clone(), r));
        if !state.apply(&item.id, r) {
            break;
        }
    }
    outcomes
}

fn load_queue(path: &Path) -> Vec<QueueItem> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            eprintln!("Focusbox: {QUEUE_FILE} is unreadable, starting empty: {e}");
            Vec::new()
        }),
        Err(_) => Vec::new(),
    }
}

/// Temp file + fsync + rename, same as appstore.rs: a crash mid-write leaves the old queue.
fn save_queue(path: &Path, items: &[QueueItem]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("could not write {QUEUE_FILE}: {e}"))?;
        f.write_all(&bytes).map_err(|e| format!("could not write {QUEUE_FILE}: {e}"))?;
        f.sync_all().map_err(|e| format!("could not flush {QUEUE_FILE}: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("could not replace {QUEUE_FILE}: {e}"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod secret {
    use super::{KEYRING_SERVICE, KEYRING_USER};

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
    }
    pub fn get() -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn set(token: &str) -> Result<(), String> {
        entry()?.set_password(token).map_err(|e| e.to_string())
    }
    pub fn clear() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod secret {
    pub fn get() -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn set(_token: &str) -> Result<(), String> {
        Err("no credential store on this platform".into())
    }
    pub fn clear() -> Result<(), String> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// The live service
// ---------------------------------------------------------------------------------------

#[derive(Clone)]
enum TokenCache {
    Unknown,
    Known(Option<String>),
}

pub struct Todoist {
    path: Mutex<Option<PathBuf>>,
    state: Mutex<QueueState>,
    /// One flush at a time, so the retry loop and a fresh park never send the same item
    /// concurrently.
    send_lock: tauri::async_runtime::Mutex<()>,
    /// Read the credential store once per run, not on every send: each read of a Keychain
    /// item can cost a prompt when the app's signature has changed (e.g. after an update).
    token: Mutex<TokenCache>,
    /// Serializes credential-store reads so concurrent callers cost one Keychain access
    /// (and at most one prompt), without holding `token` across that slow read.
    keychain_gate: Mutex<()>,
    wake: Mutex<Option<mpsc::Sender<()>>>,
    client: reqwest::Client,
}

impl Default for Todoist {
    fn default() -> Self {
        Todoist {
            path: Mutex::new(None),
            state: Mutex::new(QueueState::default()),
            send_lock: tauri::async_runtime::Mutex::new(()),
            token: Mutex::new(TokenCache::Unknown),
            keychain_gate: Mutex::new(()),
            wake: Mutex::new(None),
            client: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .unwrap_or_default(),
        }
    }
}

impl Todoist {
    fn cached_token(&self) -> Option<Option<String>> {
        match &*self.token.lock().ok()? {
            TokenCache::Known(t) => Some(t.clone()),
            TokenCache::Unknown => None,
        }
    }

    /// Blocking: may read the credential store, which can show a Keychain prompt. Never
    /// call it on the main thread; async code goes through [`Todoist::token_async`].
    fn token(&self) -> Option<String> {
        if let Some(t) = self.cached_token() {
            return t;
        }
        let _gate = self.keychain_gate.lock().ok()?;
        // Someone else may have read it while we waited for the gate.
        if let Some(t) = self.cached_token() {
            return t;
        }
        match secret::get() {
            Ok(t) => {
                if let Ok(mut cache) = self.token.lock() {
                    *cache = TokenCache::Known(t.clone());
                }
                t
            }
            Err(e) => {
                // Don't cache a failure: the next attempt may succeed (e.g. after unlock).
                eprintln!("Focusbox: could not read the Todoist key: {e}");
                None
            }
        }
    }

    async fn token_async(self: &Arc<Self>) -> Option<String> {
        if let Some(t) = self.cached_token() {
            return t;
        }
        let me = self.clone();
        tauri::async_runtime::spawn_blocking(move || me.token()).await.ok().flatten()
    }

    fn set_cached_token(&self, t: Option<String>) {
        if let Ok(mut c) = self.token.lock() {
            *c = TokenCache::Known(t);
        }
        if let Ok(mut s) = self.state.lock() {
            s.token_changed();
        }
    }

    fn persist(&self, state: &QueueState) {
        let path = self.path.lock().ok().and_then(|p| p.clone());
        if let Some(path) = path {
            if let Err(e) = save_queue(&path, &state.items) {
                eprintln!("Focusbox: {e}");
            }
        }
    }

    fn wake(&self) {
        if let Some(tx) = self.wake.lock().ok().and_then(|w| w.clone()) {
            let _ = tx.send(());
        }
    }

    async fn send_one(&self, token: &str, item: &QueueItem) -> SendResult {
        let body = serde_json::json!({ "content": item.text, "labels": [PARK_LABEL] });
        let res = self
            .client
            .post(TASKS_URL)
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .header("X-Request-Id", &item.id)
            .body(body.to_string())
            .send()
            .await;
        match res {
            Ok(r) => SendResult::from_status(r.status().as_u16()),
            Err(_) => SendResult::Retry,
        }
    }

    /// Send whatever is pending. Returns each attempted item's outcome.
    pub async fn flush(self: &Arc<Self>) -> Vec<(String, SendResult)> {
        let _one_at_a_time = self.send_lock.lock().await;
        let Some(token) = self.token_async().await else {
            return Vec::new();
        };
        let pending = match self.state.lock() {
            Ok(s) => s.pending(),
            Err(_) => return Vec::new(),
        };
        let mut outcomes = Vec::new();
        for item in pending {
            let claimed = self.state.lock().map(|mut s| s.begin(&item.id)).unwrap_or(false);
            if !claimed {
                continue;
            }
            let r = self.send_one(&token, &item).await;
            outcomes.push((item.id.clone(), r));
            let go_on = match self.state.lock() {
                Ok(mut s) => {
                    let go_on = s.apply(&item.id, r);
                    self.persist(&s);
                    go_on
                }
                Err(_) => false,
            };
            if !go_on {
                break;
            }
        }
        outcomes
    }

    fn queued(&self) -> usize {
        self.state.lock().map(|s| s.items.len()).unwrap_or(0)
    }
}

/// Called once from `setup`: load the queue and start the retry loop.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let td = app.state::<Arc<Todoist>>().inner().clone();
    if let Ok(dir) = app.path().app_data_dir() {
        let path = dir.join(QUEUE_FILE);
        if let Ok(mut s) = td.state.lock() {
            s.items = load_queue(&path);
        }
        if let Ok(mut p) = td.path.lock() {
            *p = Some(path);
        }
    }
    let (tx, rx) = mpsc::channel::<()>();
    if let Ok(mut w) = td.wake.lock() {
        *w = Some(tx);
    }
    let spawned = std::thread::Builder::new().name("todoist-queue".into()).spawn(move || loop {
        // Woken early by a new park or a new token; otherwise once a minute.
        match rx.recv_timeout(RETRY_EVERY) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let has_work = td.state.lock().map(|s| !s.pending().is_empty()).unwrap_or(false);
        if has_work {
            tauri::async_runtime::block_on(td.flush());
        }
    });
    if let Err(e) = spawned {
        eprintln!("Focusbox: could not start the Todoist queue: {e}");
    }
}

fn clip(s: &str) -> String {
    s.trim().chars().take(MAX_TEXT_CHARS).collect()
}

/// Queue `text` and try to send just that item right away (one request, bounded by the
/// client timeout). Any older backlog is left to the retry thread, so a park from the nudge
/// never waits on it. Shared by the `park` command and the nudge.
///
/// Returns "sent" | "queued" (kept, will retry) | "rejected" (Todoist refused the item) |
/// "no_token" (kept; nothing sends it until a key is saved) | "auth_blocked" (kept; the
/// saved key was refused, so nothing sends until it is replaced).
pub async fn park_text<R: Runtime>(app: &AppHandle<R>, text: &str) -> Result<String, String> {
    let text = clip(text);
    if text.is_empty() {
        return Err("nothing to park".into());
    }
    let td = app.state::<Arc<Todoist>>().inner().clone();
    let item = QueueItem { id: uuid::Uuid::new_v4().to_string(), text, created_at: now_ms() };
    let blocked = {
        let mut s = td.state.lock().map_err(|_| "queue lock poisoned".to_string())?;
        s.enqueue(item.id.clone(), item.text.clone(), item.created_at);
        td.persist(&s);
        s.auth_blocked
    };
    if blocked {
        return Ok("auth_blocked".into());
    }
    let Some(token) = td.token_async().await else {
        return Ok("no_token".into());
    };
    let claimed = td.state.lock().map(|mut s| s.begin(&item.id)).unwrap_or(false);
    if !claimed {
        // The retry thread got to it first; it's being sent.
        return Ok("queued".into());
    }
    let r = td.send_one(&token, &item).await;
    if let Ok(mut s) = td.state.lock() {
        s.apply(&item.id, r);
        td.persist(&s);
    }
    Ok(match r {
        SendResult::Sent => "sent",
        SendResult::Rejected => "rejected",
        SendResult::Unauthorized => "auth_blocked",
        SendResult::Retry => "queued",
    }
    .into())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoistStatus {
    pub configured: bool,
    pub queued: usize,
    /// The saved key was refused by Todoist; parked items wait for a new one.
    pub auth_blocked: bool,
}

// The Todoist commands are async so they never run on the main thread: a Keychain access
// can block on a system prompt, and on the main thread that is a beachball.

#[tauri::command]
pub async fn todoist_status(td: State<'_, Arc<Todoist>>) -> Result<TodoistStatus, String> {
    let td = td.inner().clone();
    let configured = td.token_async().await.is_some();
    Ok(TodoistStatus {
        configured,
        queued: td.queued(),
        auth_blocked: td.state.lock().map(|s| s.auth_blocked).unwrap_or(false),
    })
}

/// Check the key against Todoist, then store it. "ok" (valid, saved), "invalid" (refused,
/// not saved) or "offline" (couldn't check, saved anyway so parking works once online).
#[tauri::command]
pub async fn todoist_set_token(td: State<'_, Arc<Todoist>>, token: String) -> Result<String, String> {
    let token = token.trim().to_string();
    if token.is_empty() || token.len() > 200 || token.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Ok("invalid".into());
    }
    let res = td.client.get(VALIDATE_URL).bearer_auth(&token).send().await;
    let outcome = match res {
        Ok(r) if r.status().is_success() => "ok",
        Ok(r) if matches!(r.status().as_u16(), 401 | 403) => return Ok("invalid".into()),
        // No answer, or Todoist itself failing: keep the key, the queue will retry.
        _ => "offline",
    };
    let to_store = token.clone();
    tauri::async_runtime::spawn_blocking(move || secret::set(&to_store))
        .await
        .map_err(|e| e.to_string())??;
    td.set_cached_token(Some(token));
    td.wake();
    Ok(outcome.into())
}

#[tauri::command]
pub async fn todoist_clear_token(td: State<'_, Arc<Todoist>>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(secret::clear)
        .await
        .map_err(|e| e.to_string())??;
    td.set_cached_token(None);
    Ok(())
}

/// Park a task from the main window (the "new task while one is active" prompt).
#[tauri::command]
pub async fn park<R: Runtime>(app: AppHandle<R>, text: String) -> Result<String, String> {
    park_text(&app, &text).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(n: usize) -> QueueState {
        let mut s = QueueState::default();
        for i in 0..n {
            s.enqueue(format!("id{i}"), format!("task {i}"), i as u64);
        }
        s
    }

    #[test]
    fn status_codes_map_to_outcomes() {
        assert_eq!(SendResult::from_status(200), SendResult::Sent);
        assert_eq!(SendResult::from_status(204), SendResult::Sent);
        assert_eq!(SendResult::from_status(401), SendResult::Unauthorized);
        assert_eq!(SendResult::from_status(403), SendResult::Unauthorized);
        assert_eq!(SendResult::from_status(429), SendResult::Retry);
        assert_eq!(SendResult::from_status(400), SendResult::Rejected);
        assert_eq!(SendResult::from_status(410), SendResult::Rejected);
        assert_eq!(SendResult::from_status(500), SendResult::Retry);
        assert_eq!(SendResult::from_status(503), SendResult::Retry);
    }

    #[test]
    fn sent_items_are_dropped_in_order() {
        let mut s = q(3);
        let mut seen = Vec::new();
        drain_with(&mut s, |i| {
            seen.push(i.id.clone());
            SendResult::Sent
        });
        assert_eq!(seen, ["id0", "id1", "id2"]);
        assert!(s.items.is_empty());
    }

    #[test]
    fn offline_keeps_everything_and_stops_the_batch() {
        let mut s = q(3);
        let out = drain_with(&mut s, |_| SendResult::Retry);
        assert_eq!(out.len(), 1, "no point trying the rest while offline");
        assert_eq!(s.items.len(), 3);
        assert!(!s.auth_blocked);
        // Next pass, back online.
        drain_with(&mut s, |_| SendResult::Sent);
        assert!(s.items.is_empty());
    }

    #[test]
    fn unauthorized_blocks_until_the_token_changes() {
        let mut s = q(2);
        drain_with(&mut s, |_| SendResult::Unauthorized);
        assert!(s.auth_blocked);
        assert_eq!(s.items.len(), 2, "nothing is lost on a bad token");
        let mut calls = 0;
        drain_with(&mut s, |_| {
            calls += 1;
            SendResult::Sent
        });
        assert_eq!(calls, 0, "no retries while blocked");
        s.token_changed();
        drain_with(&mut s, |_| SendResult::Sent);
        assert!(s.items.is_empty());
    }

    #[test]
    fn a_rejected_item_is_dropped_and_the_batch_goes_on() {
        let mut s = q(3);
        let out = drain_with(&mut s, |i| if i.id == "id0" { SendResult::Rejected } else { SendResult::Sent });
        assert_eq!(out.len(), 3);
        assert!(s.items.is_empty());
    }

    #[test]
    fn a_retry_mid_batch_keeps_the_rest() {
        let mut s = q(3);
        drain_with(&mut s, |i| if i.id == "id1" { SendResult::Retry } else { SendResult::Sent });
        assert_eq!(s.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["id1", "id2"]);
    }

    #[test]
    fn a_claimed_item_is_never_sent_twice() {
        let mut s = q(2);
        assert!(s.begin("id1"), "a fresh park claims its own item");
        assert!(!s.begin("id1"), "a second claim fails");
        let mut seen = Vec::new();
        drain_with(&mut s, |i| {
            seen.push(i.id.clone());
            SendResult::Sent
        });
        assert_eq!(seen, ["id0"], "the backlog pass skips the claimed item");
        assert_eq!(s.items.len(), 1);
        s.apply("id1", SendResult::Retry);
        assert!(s.in_flight.is_empty(), "reporting back releases the claim");
        assert_eq!(s.pending().len(), 1, "and a retry makes it pending again");
    }

    #[test]
    fn nothing_can_be_claimed_while_auth_blocked_or_once_gone() {
        let mut s = q(1);
        s.auth_blocked = true;
        assert!(!s.begin("id0"));
        s.token_changed();
        assert!(!s.begin("missing"));
        assert!(s.begin("id0"));
    }

    #[test]
    fn queue_file_round_trips_and_garbage_reads_empty() {
        let mut dir = std::env::temp_dir();
        dir.push(format!("focusbox-todoist-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join(QUEUE_FILE);
        assert!(load_queue(&path).is_empty());
        let s = q(2);
        save_queue(&path, &s.items).unwrap();
        assert_eq!(load_queue(&path), s.items);
        assert!(!path.with_extension("json.tmp").exists());
        fs::write(&path, b"{nope").unwrap();
        assert!(load_queue(&path).is_empty());
    }
}
