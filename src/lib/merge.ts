import type { NotesValue, SettingsValue, SyncedTask } from "./syncTypes";

/** Per-item last-write-wins union with tombstones. Pure; commutative; idempotent. */
export function mergeTasks(local: SyncedTask[], remote: SyncedTask[]): SyncedTask[] {
  const byId = new Map<string, SyncedTask>();
  for (const item of [...local, ...remote]) {
    const cur = byId.get(item.id);
    if (cur === undefined) {
      byId.set(item.id, item);
      continue;
    }
    if (item.updated_at > cur.updated_at) {
      byId.set(item.id, item);
    } else if (item.updated_at === cur.updated_at && item.deleted && !cur.deleted) {
      byId.set(item.id, item); // a delete wins a same-timestamp tie
    }
  }
  // Sort by order, then id as a deterministic tiebreaker so the merged result is
  // independent of input order (true commutativity even when `order` values tie).
  return [...byId.values()].sort(
    (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Last-write-wins; ties keep local. */
export function mergeSettings(local: SettingsValue, remote: SettingsValue): SettingsValue {
  return remote.updated_at > local.updated_at ? remote : local;
}

export function sameDoc(a: NotesValue, b: NotesValue): boolean {
  return JSON.stringify(a.doc) === JSON.stringify(b.doc);
}

export interface NotesResolution {
  current: NotesValue;
  conflict?: NotesValue;
}

/**
 * Notes resolution: LWW, but if BOTH sides changed since the last synced baseline
 * and the docs actually differ, keep the newer as current and return the older as a
 * conflict copy (so nothing is silently lost). `baseUpdatedAt` is the updated_at of
 * the last successfully-synced notes (null if never synced).
 */
export function resolveNotes(
  local: NotesValue,
  remote: NotesValue,
  baseUpdatedAt: number | null,
): NotesResolution {
  // Universal invariant: an empty (null) doc has nothing to preserve and must NEVER
  // overwrite a real doc on the other side. This both (a) stops a fresh device from
  // spawning a junk conflict copy when it first pulls real notes, and (b) stops a
  // wiped/corrupt local cache from destroying the synced notes on the server. Applies
  // regardless of timestamps/baseline.
  if (local.doc === null && remote.doc !== null) return { current: remote };
  if (remote.doc === null && local.doc !== null) return { current: local };

  const localChanged = baseUpdatedAt === null ? true : local.updated_at > baseUpdatedAt;
  const remoteChanged = baseUpdatedAt === null ? true : remote.updated_at > baseUpdatedAt;
  if (localChanged && remoteChanged && !sameDoc(local, remote)) {
    // both docs are non-null here
    const [newer, older] =
      local.updated_at >= remote.updated_at ? [local, remote] : [remote, local];
    return { current: newer, conflict: older };
  }
  return { current: remote.updated_at > local.updated_at ? remote : local };
}
