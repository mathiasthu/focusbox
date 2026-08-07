//! The app's own key/value store, replacing `tauri-plugin-store`.
//!
//! Why this exists rather than the plugin: the plugin's commands take the store's file
//! path *from the caller*, and it has no path-scope facility — the `scope` tokens in its
//! ACL schema are generic capability-framework boilerplate, so `store:default` cannot be
//! narrowed the way `fs:*` can. Worse, the path is not sanitized for `AppData`:
//! `resolve_store_path` applies Tauri's `_up_`/`_root_` rewriting only when resolving a
//! *resource* path, so for `BaseDirectory::AppData` an absolute path replaces the base and
//! `..` is never collapsed. Granting the plugin therefore hands anything running in the
//! webview an arbitrary-path JSON read/write primitive: `save()` does `create_dir_all` then
//! `fs::write` with no filename or extension constraint, and `load()`/`entries()` reads any
//! JSON-parseable file back — including this app's own `focusbox.json`, which holds the
//! access token, the refresh token and the base64 account data key.
//!
//! There is no XSS sink in the app today, so that was latent rather than live. It is one
//! bug away, though, and it is not a risk this app needs to carry: it uses exactly one
//! store file, at a fixed name. Here the filename is a compile-time constant joined onto
//! the OS-resolved app-data directory, so no caller-supplied component reaches the path at
//! all and there is nothing to traverse.
//!
//! The on-disk format is byte-compatible with what the plugin wrote (a plain JSON object
//! keyed by store key), so existing installs load unchanged with no migration step.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime, State};

const FILE_NAME: &str = "focusbox.json";

/// Serializes read-modify-write cycles. Each command is a full read, patch and rewrite, so
/// two concurrent writers (the debounced app-state flush and a sync-identity save, say)
/// would otherwise be able to drop one of the two updates.
#[derive(Default)]
pub struct StoreLock(Mutex<()>);

fn store_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

fn read_map_at(path: &Path) -> Result<Map<String, Value>, String> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        // A store that has never been written is an empty store, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("could not read {FILE_NAME}: {e}")),
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => Ok(m),
        // Present but not an object: refuse rather than silently starting fresh, which
        // would overwrite whatever is really in there on the next save.
        Ok(_) => Err(format!("{FILE_NAME} is not a JSON object")),
        Err(e) => Err(format!("{FILE_NAME} is not valid JSON: {e}")),
    }
}

fn write_at(
    path: &Path,
    patch: Map<String, Value>,
    remove: &[String],
) -> Result<(), String> {
    let mut map = read_map_at(path)?;
    for (k, v) in patch {
        map.insert(k, v);
    }
    for k in remove {
        map.remove(k);
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(&Value::Object(map))
        .map_err(|e| format!("could not serialize {FILE_NAME}: {e}"))?;
    // Write to a sibling temp file and rename into place, so an interrupted write leaves
    // the previous store intact instead of a truncated one — this file holds the only copy
    // of the user's tasks and notes.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("could not write {FILE_NAME}: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("could not replace {FILE_NAME}: {e}"))?;
    Ok(())
}

/// The whole store as a JSON object (`{}` if it has never been written).
#[tauri::command]
pub fn app_store_read<R: Runtime>(
    app: AppHandle<R>,
    lock: State<'_, StoreLock>,
) -> Result<Value, String> {
    let _guard = lock.0.lock().map_err(|_| "store lock poisoned".to_string())?;
    Ok(Value::Object(read_map_at(&store_path(&app)?)?))
}

/// Merge `patch` into the store and drop the keys in `remove`, then persist.
#[tauri::command]
pub fn app_store_write<R: Runtime>(
    app: AppHandle<R>,
    lock: State<'_, StoreLock>,
    patch: Map<String, Value>,
    remove: Vec<String>,
) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|_| "store lock poisoned".to_string())?;
    write_at(&store_path(&app)?, patch, &remove)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmpdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "focusbox-appstore-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let path = tmpdir().join(FILE_NAME);
        assert!(read_map_at(&path).unwrap().is_empty());
    }

    #[test]
    fn reads_a_file_written_by_the_store_plugin_unchanged() {
        // The compatibility guarantee that makes this a drop-in replacement: the plugin
        // wrote a plain JSON object keyed by store key, and existing installs must load
        // with no migration.
        let path = tmpdir().join(FILE_NAME);
        fs::write(
            &path,
            br#"{"syncOwner":{"tag":"abc","stash":{}},"tasks":[{"id":"t1"}],"notesDoc":null}"#,
        )
        .unwrap();
        let map = read_map_at(&path).unwrap();
        assert_eq!(map["syncOwner"]["tag"], json!("abc"));
        assert_eq!(map["tasks"][0]["id"], json!("t1"));
        assert!(map["notesDoc"].is_null());
    }

    #[test]
    fn write_merges_and_leaves_other_keys_alone() {
        let path = tmpdir().join(FILE_NAME);
        write_at(&path, obj(json!({"tasks": [1], "sync": {"a": 1}})), &[]).unwrap();
        write_at(&path, obj(json!({"tasks": [1, 2]})), &[]).unwrap();
        let map = read_map_at(&path).unwrap();
        assert_eq!(map["tasks"], json!([1, 2]));
        assert_eq!(map["sync"], json!({"a": 1}));
    }

    #[test]
    fn write_can_remove_a_key() {
        let path = tmpdir().join(FILE_NAME);
        write_at(&path, obj(json!({"sync": {"a": 1}, "tasks": []})), &[]).unwrap();
        write_at(&path, Map::new(), &["sync".to_string()]).unwrap();
        let map = read_map_at(&path).unwrap();
        assert!(!map.contains_key("sync"));
        assert!(map.contains_key("tasks"));
    }

    #[test]
    fn an_explicit_null_is_stored_not_treated_as_a_delete() {
        // notesDoc is legitimately null until the user types anything, so null must round
        // trip as a value. Deletion is the separate `remove` list.
        let path = tmpdir().join(FILE_NAME);
        write_at(&path, obj(json!({"notesDoc": null})), &[]).unwrap();
        let map = read_map_at(&path).unwrap();
        assert!(map.contains_key("notesDoc"));
        assert!(map["notesDoc"].is_null());
    }

    #[test]
    fn write_leaves_no_temp_file_behind() {
        let dir = tmpdir();
        let path = dir.join(FILE_NAME);
        write_at(&path, obj(json!({"tasks": []})), &[]).unwrap();
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![FILE_NAME.to_string()]);
    }

    #[test]
    fn corrupt_json_is_an_error_rather_than_a_silent_reset() {
        // Reporting "empty store" here would let the next save overwrite a file that still
        // holds the user's only copy of their tasks and notes.
        let path = tmpdir().join(FILE_NAME);
        fs::write(&path, b"{not json").unwrap();
        assert!(read_map_at(&path).is_err());
        fs::write(&path, b"[1,2,3]").unwrap();
        assert!(read_map_at(&path).is_err());
    }
}
