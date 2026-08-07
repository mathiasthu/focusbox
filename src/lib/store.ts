import { invoke } from "@tauri-apps/api/core";
import type { SyncedTask } from "./syncTypes";
import { migrateTasks } from "./taskMap";
import { isDemo, demoTasks, demoNotesDoc } from "./demo";

// TipTap document JSON (shape varies); null until the user has typed anything.
export type NotesDoc = Record<string, unknown> | null;

export interface AppState {
  // Canonical task model carries sync metadata (order/updated_at/tombstone); the UI
  // projects a slim {id,text,done} view via taskMap.visibleTasks().
  tasks: SyncedTask[];
  notesDoc: NotesDoc;
}

const LS_KEY = "focusbox-state";

// True inside the Tauri webview; false in a plain browser (dev preview).
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// --- the app's key/value store (focusbox.json), via app-defined Rust commands ---
//
// `tauri-plugin-store` used to back this. It was dropped because its commands take the
// store's file path from the caller and it has no path-scope facility, which made
// `store:default` an arbitrary-path JSON read/write primitive for anything running in the
// webview — see the header of src-tauri/src/appstore.rs. The commands here hardcode the
// filename in Rust, so the webview never names a path at all. The file format is
// unchanged, so existing installs load as-is.

let cache: Record<string, unknown> | null = null;
let inflight: Promise<Record<string, unknown>> | null = null;

/** The whole store, read once per launch and kept in memory (every write below keeps the
 * cache in step, and nothing outside this process writes the file). */
async function readAll(): Promise<Record<string, unknown>> {
  if (cache) return cache;
  if (!inflight) {
    inflight = invoke<Record<string, unknown> | null>("app_store_read")
      .then((v) => {
        cache = v ?? {};
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function storeGet<T>(key: string): Promise<T | undefined> {
  return (await readAll())[key] as T | undefined;
}

/** Merge keys into the store and persist. Rejects if the write fails — callers that can
 * tolerate that decide so explicitly. */
export async function storeSet(patch: Record<string, unknown>): Promise<void> {
  await invoke("app_store_write", { patch, remove: [] });
  Object.assign(await readAll(), patch);
}

export async function storeRemove(...keys: string[]): Promise<void> {
  await invoke("app_store_write", { patch: {}, remove: keys });
  const c = await readAll();
  for (const k of keys) delete c[k];
}

export async function loadState(): Promise<AppState> {
  const empty: AppState = { tasks: [], notesDoc: null };
  const now = Date.now();
  try {
    if (isDemo()) {
      return { tasks: demoTasks(), notesDoc: demoNotesDoc() };
    }
    if (isTauri) {
      const tasks = migrateTasks(await storeGet("tasks"), now);
      const notesDoc = (await storeGet<NotesDoc>("notesDoc")) ?? null;
      return { tasks, notesDoc };
    }
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return { tasks: migrateTasks(parsed.tasks, now), notesDoc: parsed.notesDoc ?? null };
  } catch (err) {
    console.error("Focusbox: failed to load state, starting fresh.", err);
    return empty;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Partial<AppState> = {};

/** Debounced, partial save. Call freely on every change. */
export function saveState(partial: Partial<AppState>): void {
  if (isDemo()) return; // ephemeral demo: never persist
  pending = { ...pending, ...partial };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), 500);
}

async function flush(): Promise<void> {
  saveTimer = null;
  const toWrite = pending;
  pending = {};
  try {
    if (isTauri) {
      const patch: Record<string, unknown> = {};
      if ("tasks" in toWrite) patch.tasks = toWrite.tasks;
      if ("notesDoc" in toWrite) patch.notesDoc = toWrite.notesDoc;
      if (Object.keys(patch).length > 0) await storeSet(patch);
      return;
    }
    // Browser fallback: merge into a single localStorage record.
    const raw = localStorage.getItem(LS_KEY);
    const current = raw ? JSON.parse(raw) : {};
    localStorage.setItem(LS_KEY, JSON.stringify({ ...current, ...toWrite }));
  } catch (err) {
    console.error("Focusbox: failed to save state.", err);
  }
}
