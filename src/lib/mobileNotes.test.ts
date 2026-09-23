import { describe, expect, it } from "vitest";
import { appendNoteItem, noteChecklistItems, setNoteItemDone } from "./mobileNotes";

const text = (value: string, marks?: { type: string }[]) => ({
  type: "text", text: value, ...(marks ? { marks } : {}),
});
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const bullet = (...content: unknown[]) => ({ type: "listItem", content });
const list = (...content: unknown[]) => ({ type: "bulletList", content });

describe("mobile Notes checklist", () => {
  it("reads bullet, ordered, task and nested items, excluding prose and headings", () => {
    const doc = {
      type: "doc", content: [
        { type: "heading", content: [text("Plan")] },
        para(text("Keep this prose")),
        list(
          bullet(para(text("First")), list(bullet(para(text("Nested"))))),
          bullet(para(text("Done", [{ type: "strike" }]))),
        ),
        { type: "orderedList", content: [bullet(para(text("Second")))] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [para(text("Third"))] }] },
      ],
    };
    expect(noteChecklistItems(doc)).toEqual([
      { path: [2, 0], text: "First", done: false, depth: 0 },
      { path: [2, 0, 1, 0], text: "Nested", done: false, depth: 1 },
      { path: [2, 1], text: "Done", done: true, depth: 0 },
      { path: [3, 0], text: "Second", done: false, depth: 0 },
      { path: [4, 0], text: "Third", done: true, depth: 0 },
    ]);
  });

  it("strikes and unstrikes only the selected bullet's own text, keeping formatting and nested children", () => {
    const doc = {
      type: "doc", content: [list(
        bullet(para(text("First", [{ type: "bold" }])), list(bullet(para(text("Child"))))),
        bullet(para(text("Other"))),
      )],
    };
    const done = setNoteItemDone(doc, [0, 0], true);
    expect(noteChecklistItems(done).map((item) => item.done)).toEqual([true, false, false]);
    expect((done as any).content[0].content[0].content[0].content[0].marks)
      .toEqual([{ type: "bold" }, { type: "strike" }]);
    expect(setNoteItemDone(done, [0, 0], false)).toEqual(doc);
    expect((doc as any).content[0].content[0].content[0].content[0].marks).toEqual([{ type: "bold" }]);
  });

  it("checks native task items without changing the adjacent note", () => {
    const doc = {
      type: "doc", content: [{ type: "taskList", content: [
        { type: "taskItem", attrs: { checked: false, focused: true }, content: [para(text("Call"))] },
        { type: "taskItem", attrs: { checked: true }, content: [para(text("Write"))] },
      ] }],
    };
    const result = setNoteItemDone(doc, [0, 0], true);
    expect((result as any).content[0].content[0].attrs).toEqual({ checked: true, focused: true });
    expect((result as any).content[0].content[1]).toBe(doc.content[0].content[1]);
    expect(setNoteItemDone(result, [0, 0], false)).toEqual(doc);
  });

  it("appends bullets to the existing note, preserves prose, and handles empty notes", () => {
    const doc = { type: "doc", content: [para(text("Keep")), list(bullet(para(text("Old")))), para()] };
    const added = appendNoteItem(doc, " New ");
    expect(noteChecklistItems(added).map((item) => item.text)).toEqual(["Old", "New"]);
    expect((added as any).content[0]).toBe(doc.content[0]);
    expect(doc.content).toHaveLength(3);
    expect(noteChecklistItems(appendNoteItem(null, "First"))[0].text).toBe("First");
    expect(appendNoteItem(doc, "  ")).toBe(doc);
    expect(setNoteItemDone(doc, [99, 0], true)).toBe(doc);
  });
});
