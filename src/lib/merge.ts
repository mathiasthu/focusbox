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
  const localChanged = baseUpdatedAt === null ? true : local.updated_at > baseUpdatedAt;
  const remoteChanged = baseUpdatedAt === null ? true : remote.updated_at > baseUpdatedAt;
  if (localChanged && remoteChanged && !sameDoc(local, remote)) {
    const [newer, older] =
      local.updated_at >= remote.updated_at ? [local, remote] : [remote, local];
    return { current: newer, conflict: older };
  }
  return { current: remote.updated_at > local.updated_at ? remote : local };
}
