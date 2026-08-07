// The plaintext shapes that get encrypted into server blobs. Each carries the
// metadata the merge engine needs (updated_at; tombstones for tasks).

/** epoch milliseconds */
export type Millis = number;

/**
 * How far ahead of this device's clock an ingested `updated_at` may be before it is
 * treated as bogus and pulled back to now.
 *
 * LWW gives an item with a far-future stamp permanent immunity: it beats every honest
 * edit AND every tombstone, so a task carrying `updated_at = 2099` resurrects itself on
 * every sync, on every device, until the wall clock catches up. There is no attacker here
 * — it takes the user's own skewed clock or a hand-edited state file — but the wedge is
 * unrecoverable through the UI, so clamp wherever data enters the model. The window is
 * wide enough to absorb ordinary clock disagreement between a user's own devices.
 */
export const SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * A timestamp coerced finite and, if implausibly far in the future, replaced with `now`.
 *
 * Note the shape: a value inside the window is left EXACTLY as it is (so ordinary skew
 * between a user's devices is never rewritten, and a pulled blob doesn't get re-stamped
 * and re-pushed on every cycle), and a value outside it collapses to `now` rather than
 * being pulled back to the window's edge. Clamping to `now + SKEW_TOLERANCE_MS` would
 * leave the poisoned item still ahead of every honest edit and every tombstone for a
 * further 24 hours — a shorter wedge is still a wedge.
 */
export function clampStamp(value: unknown, fallback: number, now: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value > now + SKEW_TOLERANCE_MS ? now : value;
}

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
  showTasks: boolean;
  menubarTimer: boolean;
  chime: boolean;
  chimeSound: string;
  updated_at: Millis;
}

// Server blob keys (opaque to the server). Conflict copies use a unique suffix.
export const KEY_TASKS = "tasks";
export const KEY_NOTES = "notes";
export const KEY_SETTINGS = "settings";
export const notesConflictKey = (id: string) => `notes_conflict:${id}`;

/** The keys whose server version must never move backwards. Conflict copies are excluded:
 * they are write-once and deleted on restore/discard, so they have no version history. */
export const VERSIONED_KEYS = [KEY_TASKS, KEY_NOTES, KEY_SETTINGS] as const;

/**
 * A fresh conflict-copy key with no structure in it.
 *
 * These keys are the one part of sync the server reads in the clear. The old shape,
 * `notes_conflict:<deviceUUID>-<epochMs>`, handed it a stable per-device identifier and a
 * millisecond edit timestamp on every conflict — enough to assemble a per-device activity
 * timeline from key names alone, without touching a single ciphertext. A random id says
 * only "a conflict copy exists"; the timestamp the UI shows comes from the blob's own
 * server-side `updated_at`, which the server necessarily knows anyway.
 */
export function newNotesConflictKey(): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return notesConflictKey(id);
}
