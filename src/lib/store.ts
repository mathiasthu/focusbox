import { load, type Store } from "@tauri-apps/plugin-store";
import type { SyncedTask } from "./syncTypes";
import { migrateTasks } from "./taskMap";

// TipTap document JSON (shape varies); null until the user has typed anything.
export type NotesDoc = Record<string, unknown> | null;

export interface AppState {
  // Canonical task model carries sync metadata (order/updated_at/tombstone); the UI
  // projects a slim {id,text,done} view via taskMap.visibleTasks().
  tasks: SyncedTask[];
  notesDoc: NotesDoc;
}

const FILE = "focusbox.json";
const LS_KEY = "focusbox-state";

// True inside the Tauri webview; false in a plain browser (dev preview).
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let storePromise: Promise<Store> | null = null;

/** The shared plugin-store instance (focusbox.json). Reused by syncStore so both
 * write to the same file without a second handle. */
export function getStore(): Promise<Store> {
  if (!storePromise) {
    // autoSave off — we control persistence via the debounced flush below.
    storePromise = load(FILE, { defaults: {}, autoSave: false });
  }
  return storePromise;
}

export async function loadState(): Promise<AppState> {
  const empty: AppState = { tasks: [], notesDoc: null };
  const now = Date.now();
  try {
    if (isTauri) {
      const store = await getStore();
      const tasks = migrateTasks(await store.get("tasks"), now);
      const notesDoc = (await store.get<NotesDoc>("notesDoc")) ?? null;
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
      const store = await getStore();
      if ("tasks" in toWrite) await store.set("tasks", toWrite.tasks);
      if ("notesDoc" in toWrite) await store.set("notesDoc", toWrite.notesDoc);
      await store.save();
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
