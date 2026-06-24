import { describe, expect, it } from "vitest";
import { migrateTasks, reconcileTasks, visibleTasks, type VisibleTask } from "./taskMap";
import type { SyncedTask } from "./syncTypes";

const t = (id: string, over: Partial<SyncedTask> = {}): SyncedTask => ({
  id,
  text: id,
  done: false,
  order: 0,
  updated_at: 1,
  ...over,
});
const v = (id: string, over: Partial<VisibleTask> = {}): VisibleTask => ({
  id,
  text: id,
  done: false,
  ...over,
});

describe("visibleTasks", () => {
  it("hides tombstones and sorts by order then id", () => {
    const all = [
      t("b", { order: 1 }),
      t("a", { order: 0 }),
      t("z", { order: 0, deleted: true }),
      t("c", { order: 0 }),
    ];
    expect(visibleTasks(all).map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("projects only id/text/done", () => {
    expect(visibleTasks([t("a", { text: "hi", done: true })])).toEqual([
      { id: "a", text: "hi", done: true },
    ]);
  });
});

describe("reconcileTasks", () => {
  it("stamps a brand-new task with now + order index", () => {
    const out = reconcileTasks([], [v("a", { text: "new" })], 100);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", text: "new", order: 0, updated_at: 100, deleted: false });
  });

  it("re-stamps a toggled (done changed) task", () => {
    const prev = [t("a", { done: false, updated_at: 1, order: 0 })];
    const out = reconcileTasks(prev, [v("a", { done: true })], 200);
    expect(out[0].done).toBe(true);
    expect(out[0].updated_at).toBe(200);
  });

  it("re-stamps an edited (text changed) task", () => {
    const prev = [t("a", { text: "old", updated_at: 1 })];
    const out = reconcileTasks(prev, [v("a", { text: "new" })], 300);
    expect(out[0].text).toBe("new");
    expect(out[0].updated_at).toBe(300);
  });

  it("does NOT re-stamp an unchanged task", () => {
    const prev = [t("a", { text: "same", done: false, order: 0, updated_at: 42 })];
    const out = reconcileTasks(prev, [v("a", { text: "same", done: false })], 999);
    expect(out[0].updated_at).toBe(42);
  });

  it("re-stamps + reorders when position changes", () => {
    const prev = [t("a", { order: 0, updated_at: 1 }), t("b", { order: 1, updated_at: 1 })];
    // user moved b before a
    const out = reconcileTasks(prev, [v("b"), v("a")], 500);
    const b = out.find((x) => x.id === "b")!;
    const a = out.find((x) => x.id === "a")!;
    expect(b.order).toBe(0);
    expect(a.order).toBe(1);
    expect(b.updated_at).toBe(500); // order changed -> re-stamped
  });

  it("turns a removed task into a tombstone", () => {
    const prev = [t("a", { updated_at: 1 }), t("b", { updated_at: 1 })];
    const out = reconcileTasks(prev, [v("a")], 700);
    const b = out.find((x) => x.id === "b")!;
    expect(b.deleted).toBe(true);
    expect(b.updated_at).toBe(700);
  });

  it("preserves an already-existing tombstone without re-stamping", () => {
    const prev = [t("a", { updated_at: 1 }), t("z", { deleted: true, updated_at: 9 })];
    const out = reconcileTasks(prev, [v("a")], 800);
    const z = out.find((x) => x.id === "z")!;
    expect(z.deleted).toBe(true);
    expect(z.updated_at).toBe(9); // untouched
  });

  it("keeps tombstones out of the visible projection after reconcile", () => {
    const prev = [t("a", { updated_at: 1 }), t("b", { updated_at: 1 })];
    const out = reconcileTasks(prev, [v("a")], 700);
    expect(visibleTasks(out).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("migrateTasks", () => {
  it("coerces legacy {id,text,done} into SyncedTask with metadata", () => {
    const out = migrateTasks([{ id: "a", text: "x", done: true }], 1000);
    expect(out[0]).toMatchObject({ id: "a", text: "x", done: true, order: 0, updated_at: 1000, deleted: false });
  });

  it("preserves existing metadata when present", () => {
    const out = migrateTasks(
      [{ id: "a", text: "x", done: false, order: 3, updated_at: 55, deleted: true }],
      1000,
    );
    expect(out[0]).toMatchObject({ order: 3, updated_at: 55, deleted: true });
  });

  it("returns [] for non-array / garbage input", () => {
    expect(migrateTasks(null, 1)).toEqual([]);
    expect(migrateTasks("nope", 1)).toEqual([]);
    expect(migrateTasks([{ nope: true }], 1)).toEqual([]); // drops entries without an id
  });
});
