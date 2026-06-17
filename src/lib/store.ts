import { load, type Store } from "@tauri-apps/plugin-store";

export interface Task {
  id: string;
  text: string;
  done: boolean;
}

// TipTap document JSON (shape varies); null until the user has typed anything.
export type NotesDoc = Record<string, unknown> | null;

export interface AppState {
  tasks: Task[];
  notesDoc: NotesDoc;
}

const FILE = "focusbox.json";
let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    // autoSave off — we control persistence via the debounced flush below.
    storePromise = load(FILE, { defaults: {}, autoSave: false });
  }
  return storePromise;
}

export async function loadState(): Promise<AppState> {
  const store = await getStore();
  const tasks = (await store.get<Task[]>("tasks")) ?? [];
  const notesDoc = (await store.get<NotesDoc>("notesDoc")) ?? null;
  return { tasks, notesDoc };
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
  const store = await getStore();
  if ("tasks" in toWrite) await store.set("tasks", toWrite.tasks);
  if ("notesDoc" in toWrite) await store.set("notesDoc", toWrite.notesDoc);
  await store.save();
}
