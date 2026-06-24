// The plaintext shapes that get encrypted into server blobs. Each carries the
// metadata the merge engine needs (updated_at; tombstones for tasks).

/** epoch milliseconds */
export type Millis = number;

export interface SyncedTask {
  id: string;
  text: string;
  done: boolean;
  order: number;
  updated_at: Millis;
  deleted?: boolean; // tombstone retained for cross-device delete propagation
}

export interface TasksBlob {
  items: SyncedTask[];
}

export interface NotesValue {
  doc: Record<string, unknown> | null;
  updated_at: Millis;
}

export interface SettingsValue {
  theme: string;
  accent: string;
  spotifyEnabled: boolean;
  updated_at: Millis;
}

// Server blob keys (opaque to the server). Conflict copies use a unique suffix.
export const KEY_TASKS = "tasks";
export const KEY_NOTES = "notes";
export const KEY_SETTINGS = "settings";
export const notesConflictKey = (id: string) => `notes_conflict:${id}`;
