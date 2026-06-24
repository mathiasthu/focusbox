import type { SyncedTask } from "./syncTypes";

/** The slim shape the TaskList component reads/returns (no sync metadata). */
export interface VisibleTask {
  id: string;
  text: string;
  done: boolean;
}

/** Live tasks for the UI: drop tombstones, sort by order then id (stable). */
export function visibleTasks(all: SyncedTask[]): VisibleTask[] {
  return all
    .filter((t) => !t.deleted)
    .slice()
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({ id: t.id, text: t.text, done: t.done }));
}

/**
 * Fold the list TaskList hands back (visible only, no metadata) into the canonical
 * `SyncedTask[]` against the previous full state:
 *  - new id            → stamp updated_at=now, order=position, deleted=false
 *  - text/done/order   → re-stamp updated_at=now
 *  - unchanged         → keep as-is (no churn)
 *  - prev id now absent → tombstone (stamp), unless it was already a tombstone (keep)
 * Tombstones are carried through so deletes propagate across devices.
 */
export function reconcileTasks(
  prev: SyncedTask[],
  visible: VisibleTask[],
  now: number,
): SyncedTask[] {
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: SyncedTask[] = [];

  visible.forEach((vt, i) => {
    seen.add(vt.id);
    const p = prevById.get(vt.id);
    if (!p) {
      out.push({ id: vt.id, text: vt.text, done: vt.done, order: i, updated_at: now, deleted: false });
      return;
    }
    const changed = p.text !== vt.text || p.done !== vt.done || p.order !== i || p.deleted === true;
    out.push(
      changed
        ? { id: p.id, text: vt.text, done: vt.done, order: i, updated_at: now, deleted: false }
        : p,
    );
  });

  // Anything in prev that's no longer visible: tombstone it (once).
  for (const p of prev) {
    if (seen.has(p.id)) continue;
    out.push(p.deleted ? p : { ...p, deleted: true, updated_at: now });
  }
  return out;
}

/** Coerce persisted/legacy task data into valid SyncedTask[] (drops entries with no id). */
export function migrateTasks(raw: unknown, now: number): SyncedTask[] {
  if (!Array.isArray(raw)) return [];
  const out: SyncedTask[] = [];
  raw.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string") return;
    out.push({
      id: o.id,
      text: typeof o.text === "string" ? o.text : "",
      done: o.done === true,
      order: typeof o.order === "number" && Number.isFinite(o.order) ? o.order : i,
      updated_at:
        typeof o.updated_at === "number" && Number.isFinite(o.updated_at) ? o.updated_at : now,
      deleted: o.deleted === true,
    });
  });
  return out;
}
