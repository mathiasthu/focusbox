import { describe, it, expect } from "vitest";
import { getFocusedTask, clearFocused, markFocusedDone, clearDone } from "./focusedLine";

const text = (t: string, marks?: unknown[]) =>
  marks ? { type: "text", text: t, marks } : { type: "text", text: t };
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const li = (attrs: Record<string, unknown> | undefined, ...content: unknown[]) =>
  attrs ? { type: "listItem", attrs, content } : { type: "listItem", content };
const task = (attrs: Record<string, unknown>, ...content: unknown[]) => ({
  type: "taskItem", attrs, content,
});
const doc = (...content: unknown[]) => ({ type: "doc", content });

describe("getFocusedTask", () => {
  it("returns null when nothing is focused (or doc is null)", () => {
    expect(getFocusedTask(null)).toBeNull();
    expect(
      getFocusedTask(doc({ type: "bulletList", content: [li(undefined, para(text("a")))] })),
    ).toBeNull();
  });

  it("finds a focused bullet line with its text", () => {
    const d = doc({
      type: "bulletList",
      content: [li(undefined, para(text("a"))), li({ focused: true }, para(text("write report")))],
    });
    expect(getFocusedTask(d)).toEqual({ text: "write report", done: false });
  });

  it("bullet line is done only when ALL its text is struck", () => {
    const struck = doc({
      type: "bulletList",
      content: [li({ focused: true }, para(text("write report", [{ type: "strike" }])))],
    });
    expect(getFocusedTask(struck)).toEqual({ text: "write report", done: true });
    const partial = doc({
      type: "bulletList",
      content: [li({ focused: true }, para(text("write ", [{ type: "strike" }]), text("report")))],
    });
    expect(getFocusedTask(partial)).toEqual({ text: "write report", done: false });
  });

  it("taskItem is done when checked", () => {
    const d = doc({
      type: "taskList",
      content: [task({ checked: true, focused: true }, para(text("call bank")))],
    });
    expect(getFocusedTask(d)).toEqual({ text: "call bank", done: true });
  });

  it("empty focused line yields empty text, not done", () => {
    const d = doc({ type: "bulletList", content: [li({ focused: true }, para())] });
    expect(getFocusedTask(d)).toEqual({ text: "", done: false });
  });

  it("takes the first focused node if several exist", () => {
    const d = doc({
      type: "bulletList",
      content: [li({ focused: true }, para(text("first"))), li({ focused: true }, para(text("second")))],
    });
    expect(getFocusedTask(d)).toEqual({ text: "first", done: false });
  });
});

describe("clearFocused", () => {
  it("removes focused from every node, returns a new doc", () => {
    const d = doc({
      type: "bulletList",
      content: [li({ focused: true }, para(text("a"))), li({ focused: true }, para(text("b")))],
    });
    const out = clearFocused(d);
    expect(getFocusedTask(out)).toBeNull();
    expect(out).not.toBe(d); // no mutation
    expect(getFocusedTask(d)).not.toBeNull(); // original untouched
  });

  it("returns the same doc when nothing was focused (and null for null)", () => {
    const d = doc({ type: "bulletList", content: [li(undefined, para(text("a")))] });
    expect(clearFocused(d)).toBe(d);
    expect(clearFocused(null)).toBeNull();
  });
});

describe("markFocusedDone", () => {
  it("checks a focused taskItem (keeps focused attr)", () => {
    const d = doc({
      type: "taskList",
      content: [task({ checked: false, focused: true }, para(text("call bank")))],
    });
    const out = markFocusedDone(d);
    expect(getFocusedTask(out)).toEqual({ text: "call bank", done: true });
  });

  it("strikes every text node of a focused bullet line (keeps focused attr, preserves other marks)", () => {
    const d = doc({
      type: "bulletList",
      content: [li({ focused: true }, para(text("write ", [{ type: "bold" }]), text("report")))],
    });
    const out = markFocusedDone(d);
    const t = getFocusedTask(out);
    expect(t).toEqual({ text: "write report", done: true });
    // bold preserved alongside strike
    const item = (out as any).content[0].content[0];
    const first = item.content[0].content[0];
    expect(first.marks).toEqual(
      expect.arrayContaining([{ type: "bold" }, { type: "strike" }]),
    );
  });

  it("no-ops (same reference) when nothing is focused / doc null", () => {
    const d = doc({ type: "bulletList", content: [li(undefined, para(text("a")))] });
    expect(markFocusedDone(d)).toBe(d);
    expect(markFocusedDone(null)).toBeNull();
  });
});

describe("clearDone", () => {
  it("unchecks a focused done taskItem (keeps focused attr)", () => {
    const d = doc({
      type: "taskList",
      content: [task({ checked: true, focused: true }, para(text("call bank")))],
    });
    const out = clearDone(d);
    expect(getFocusedTask(out)).toEqual({ text: "call bank", done: false });
  });

  it("un-strikes every text node of a focused done bullet line (keeps other marks)", () => {
    const d = doc({
      type: "bulletList",
      content: [
        li(
          { focused: true },
          para(
            text("write ", [{ type: "bold" }, { type: "strike" }]),
            text("report", [{ type: "strike" }]),
          ),
        ),
      ],
    });
    const out = clearDone(d);
    expect(getFocusedTask(out)).toEqual({ text: "write report", done: false });
    const item = (out as any).content[0].content[0];
    const first = item.content[0].content[0];
    expect(first.marks).toEqual([{ type: "bold" }]);
    const second = item.content[0].content[1];
    expect(second.marks).toBeUndefined();
  });

  it("no-ops (same reference) when the focused line is NOT done", () => {
    const d = doc({
      type: "bulletList",
      content: [li({ focused: true }, para(text("write report")))],
    });
    expect(clearDone(d)).toBe(d);
  });

  it("no-ops (same reference) when nothing is focused / doc null", () => {
    const d = doc({ type: "bulletList", content: [li(undefined, para(text("a")))] });
    expect(clearDone(d)).toBe(d);
    expect(clearDone(null)).toBeNull();
  });
});
