import { describe, expect, it } from "vitest";
import { mergeTasks, mergeSettings, resolveNotes, sameDoc } from "./merge";
import type { SyncedTask, NotesValue, SettingsValue } from "./syncTypes";

const t = (id: string, over: Partial<SyncedTask> = {}): SyncedTask => ({
  id,
  text: id,
  done: false,
  order: 0,
  updated_at: 1,
  ...over,
});

describe("mergeTasks (per-item LWW + tombstones)", () => {
  it("unions disjoint ids", () => {
    const out = mergeTasks([t("a")], [t("b")]);
    expect(out.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });

  it("newer updated_at wins for the same id", () => {
    const out = mergeTasks(
      [t("a", { text: "old", updated_at: 1 })],
      [t("a", { text: "new", updated_at: 2 })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("new");
  });

  it("a delete (tombstone) propagates and wins over an older edit", () => {
    const out = mergeTasks(
      [t("a", { text: "edit", updated_at: 2 })],
      [t("a", { deleted: true, updated_at: 5 })],
    );
    expect(out[0].deleted).toBe(true);
  });

  it("tombstone wins on an equal timestamp tie", () => {
    const out = mergeTasks([t("a", { updated_at: 3 })], [t("a", { deleted: true, updated_at: 3 })]);
    expect(out[0].deleted).toBe(true);
  });

  it("is commutative (same result set regardless of arg order)", () => {
    const a = [t("a", { updated_at: 2 }), t("b", { updated_at: 1 })];
    const b = [t("a", { updated_at: 5 }), t("c", { updated_at: 1 })];
    const ab = mergeTasks(a, b);
    const ba = mergeTasks(b, a);
    expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
  });

  it("sorts by order", () => {
    const out = mergeTasks([t("a", { order: 2 }), t("b", { order: 0 })], []);
    expect(out.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("mergeSettings (LWW)", () => {
  const s = (over: Partial<SettingsValue>): SettingsValue => ({
    theme: "system",
    accent: "clay",
    spotifyEnabled: true,
    updated_at: 1,
    ...over,
  });
  it("newer wins", () => {
    expect(
      mergeSettings(s({ accent: "old", updated_at: 1 }), s({ accent: "new", updated_at: 2 })).accent,
    ).toBe("new");
  });
  it("ties keep local", () => {
    expect(
      mergeSettings(s({ accent: "local", updated_at: 5 }), s({ accent: "remote", updated_at: 5 }))
        .accent,
    ).toBe("local");
  });
});

describe("resolveNotes (LWW + conflict-copy)", () => {
  const n = (doc: unknown, updated_at: number): NotesValue => ({
    doc: doc as Record<string, unknown>,
    updated_at,
  });

  it("only local changed -> take local, no conflict", () => {
    const r = resolveNotes(n({ v: "local" }, 5), n({ v: "base" }, 1), 1);
    expect(r.current.doc).toEqual({ v: "local" });
    expect(r.conflict).toBeUndefined();
  });

  it("only remote changed -> take remote, no conflict", () => {
    const r = resolveNotes(n({ v: "base" }, 1), n({ v: "remote" }, 5), 1);
    expect(r.current.doc).toEqual({ v: "remote" });
    expect(r.conflict).toBeUndefined();
  });

  it("both diverged with different docs -> newer current + older conflict", () => {
    const r = resolveNotes(n({ v: "local" }, 7), n({ v: "remote" }, 9), 1);
    expect(r.current.doc).toEqual({ v: "remote" });
    expect(r.conflict?.doc).toEqual({ v: "local" });
  });

  it("both changed but identical docs -> no conflict", () => {
    const r = resolveNotes(n({ v: "same" }, 7), n({ v: "same" }, 9), 1);
    expect(r.conflict).toBeUndefined();
    expect(r.current.doc).toEqual({ v: "same" });
  });

  it("sameDoc deep-compares", () => {
    expect(sameDoc(n({ a: [1, 2] }, 1), n({ a: [1, 2] }, 9))).toBe(true);
    expect(sameDoc(n({ a: [1, 2] }, 1), n({ a: [1, 3] }, 9))).toBe(false);
  });

  it("a null local doc never spawns a conflict copy (fresh device adopts remote)", () => {
    // never-synced baseline + empty local + real remote: take remote, no junk conflict
    const r = resolveNotes(n(null, 0), n({ v: "remote" }, 9), null);
    expect(r.current.doc).toEqual({ v: "remote" });
    expect(r.conflict).toBeUndefined();
  });

  it("a null remote doc never spawns a conflict copy (keeps local)", () => {
    const r = resolveNotes(n({ v: "local" }, 9), n(null, 0), null);
    expect(r.current.doc).toEqual({ v: "local" });
    expect(r.conflict).toBeUndefined();
  });

  it("a wiped local cache never overwrites a real remote doc, even at an equal/synced baseline", () => {
    // Regression: local was cleared (doc null) but its updated_at still equals the
    // synced baseline + remote — must adopt remote, NOT push null over it.
    const r = resolveNotes(n(null, 100), n({ v: "remote" }, 100), 100);
    expect(r.current.doc).toEqual({ v: "remote" });
    expect(r.conflict).toBeUndefined();
  });
});
