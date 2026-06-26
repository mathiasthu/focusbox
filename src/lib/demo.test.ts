import "./testDomShim";
import { afterEach, describe, expect, it } from "vitest";
import { isDemo, demoTasks, demoNotesDoc } from "./demo";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("isDemo", () => {
  it("is false on the normal path", () => {
    window.history.replaceState({}, "", "/");
    expect(isDemo()).toBe(false);
  });
  it("is true with ?demo=1", () => {
    window.history.replaceState({}, "", "/?demo=1");
    expect(isDemo()).toBe(true);
  });
  it("is true on the /demo route", () => {
    window.history.replaceState({}, "", "/demo");
    expect(isDemo()).toBe(true);
  });
});

describe("demo sample content", () => {
  it("returns prefilled sample tasks with sync metadata", () => {
    const tasks = demoTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    for (const t of tasks) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.text).toBe("string");
      expect(typeof t.order).toBe("number");
      expect(typeof t.updated_at).toBe("number");
    }
    expect(tasks.some((t) => t.done)).toBe(true);
  });
  it("returns a TipTap doc with content", () => {
    const doc = demoNotesDoc() as { type: string; content: unknown[] };
    expect(doc.type).toBe("doc");
    expect(Array.isArray(doc.content)).toBe(true);
    expect(doc.content.length).toBeGreaterThan(0);
  });
  it("returns fresh copies each call (no shared mutation)", () => {
    expect(demoTasks()).not.toBe(demoTasks());
    expect(demoNotesDoc()).not.toBe(demoNotesDoc());
  });
});
