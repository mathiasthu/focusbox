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

/**
 * Last-write-wins. A timestamp tie is broken on content, NOT on "keep local".
 *
 * "Keep local" is not commutative: two devices holding different settings at the same
 * `updated_at` each decide their own copy won, each pushes it, and each then sees the
 * other's — a ping-pong with no fixed point. Ordering by serialized content makes both
 * devices pick the same side and converge on the next cycle.
 */
export function mergeSettings(local: SettingsValue, remote: SettingsValue): SettingsValue {
  if (remote.updated_at !== local.updated_at) {
    return remote.updated_at > local.updated_at ? remote : local;
  }
  const l = JSON.stringify(local);
  const r = JSON.stringify(remote);
  return r > l ? remote : local;
}

export function sameDoc(a: NotesValue, b: NotesValue): boolean {
  return JSON.stringify(a.doc ?? null) === JSON.stringify(b.doc ?? null);
}

/**
 * Does this side actually carry a note?
 *
 * `=== null` is not enough. A value whose `doc` key is MISSING (so `doc` reads back as
 * `undefined`) is just as empty, and it arrives in practice: any object that isn't a
 * NotesValue — a settings blob a hostile server misrouted onto the notes key, a
 * hand-edited state file, a blob from a future schema — deserializes into exactly that
 * shape. A `=== null` test lets such a value through the emptiness guards, win LWW on
 * timestamp, and then get pushed back with `JSON.stringify` silently dropping the
 * undefined key — a validly-signed, doc-less note that wipes every device.
 */
export function hasDoc(v: NotesValue): boolean {
  return v.doc !== null && v.doc !== undefined;
}

/** A doc-less value normalized to an explicit `null` doc, so it can never be serialized
 * as an object with the `doc` key missing entirely. */
function withNullDoc(v: NotesValue): NotesValue {
  return hasDoc(v) ? v : { ...v, doc: null };
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
  // Universal invariant: an empty doc has nothing to preserve and must NEVER overwrite a
  // real doc on the other side. This both (a) stops a fresh device from spawning a junk
  // conflict copy when it first pulls real notes, and (b) stops a wiped/corrupt local
  // cache — or a misrouted server response — from destroying the synced notes. Applies
  // regardless of timestamps/baseline. Emptiness is `hasDoc`, NOT `=== null`: see there.
  if (!hasDoc(local) && hasDoc(remote)) return { current: remote };
  if (!hasDoc(remote) && hasDoc(local)) return { current: local };
  // Neither side has a doc: settle on one, but hand back an explicit null.
  if (!hasDoc(local) && !hasDoc(remote)) {
    return { current: withNullDoc(remote.updated_at > local.updated_at ? remote : local) };
  }

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
