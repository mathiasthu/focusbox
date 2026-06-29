import { describe, expect, it } from "vitest";
import {
  checkedLine,
  insertNodeAtPath,
  returnItemToNotes,
  type FocusItem,
} from "./focusReturn";

// A small helper to build a doc of plain-paragraph "lines".
function paras(...texts: string[]) {
  return {
    type: "doc",
    content: texts.map((t) => ({
      type: "paragraph",
      content: [{ type: "text", text: t }],
    })),
  };
}
const para = (t: string) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
const lineText = (node: any) =>
  // first text leaf of a taskList -> taskItem -> paragraph -> text
  node?.content?.[0]?.content?.[0]?.content?.[0]?.text;

describe("insertNodeAtPath — top-level", () => {
  it("inserts at the start", () => {
    const out = insertNodeAtPath(paras("a", "b"), [0], para("x")) as any;
    expect(out.content.map((n: any) => n.content[0].text)).toEqual(["x", "a", "b"]);
  });

  it("inserts in the middle at the recorded index", () => {
    const out = insertNodeAtPath(paras("a", "b", "c"), [1], para("x")) as any;
    expect(out.content.map((n: any) => n.content[0].text)).toEqual(["a", "x", "b", "c"]);
  });

  it("inserts at the end when index == length", () => {
    const out = insertNodeAtPath(paras("a", "b"), [2], para("x")) as any;
    expect(out.content.map((n: any) => n.content[0].text)).toEqual(["a", "b", "x"]);
  });

  it("clamps an out-of-range index to the end", () => {
    const out = insertNodeAtPath(paras("a"), [9], para("x")) as any;
    expect(out.content.map((n: any) => n.content[0].text)).toEqual(["a", "x"]);
  });

  it("does not mutate the input doc", () => {
    const doc = paras("a", "b");
    const before = JSON.stringify(doc);
    insertNodeAtPath(doc, [1], para("x"));
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("insertNodeAtPath — null / malformed doc", () => {
  it("turns a null doc into a fresh doc holding the node", () => {
    const out = insertNodeAtPath(null, [0], para("x")) as any;
    expect(out).toEqual({ type: "doc", content: [para("x")] });
  });

  it("turns a contentless doc into a fresh doc holding the node", () => {
    const out = insertNodeAtPath({ type: "doc" } as any, [0], para("x")) as any;
    expect(out.content).toEqual([para("x")]);
  });
});

describe("insertNodeAtPath — into a list", () => {
  const docWithList = () => ({
    type: "doc",
    content: [
      para("intro"),
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [para("one")] },
          { type: "taskItem", attrs: { checked: false }, content: [para("three")] },
        ],
      },
    ],
  });

  it("inserts an item at item-index j inside the list at top-level i", () => {
    const item = { type: "taskItem", attrs: { checked: false }, content: [para("two")] };
    const out = insertNodeAtPath(docWithList(), [1, 1], item) as any;
    const items = out.content[1].content.map((n: any) => n.content[0].content[0].text);
    expect(items).toEqual(["one", "two", "three"]);
  });

  it("falls back to wrapping a bare taskItem at top-level i when the list is gone", () => {
    // doc no longer has a list at index 1 (it's a paragraph now)
    const noList = paras("intro", "replaced");
    const item = { type: "taskItem", attrs: { checked: false }, content: [para("orphan")] };
    const out = insertNodeAtPath(noList, [1, 0], item) as any;
    expect(out.content[1].type).toBe("taskList");
    expect(out.content[1].content[0].content[0].content[0].text).toBe("orphan");
  });
});

describe("checkedLine", () => {
  it("builds a checked taskList line carrying the text", () => {
    const node = checkedLine("ship it") as any;
    expect(node.type).toBe("taskList");
    expect(node.content[0].type).toBe("taskItem");
    expect(node.content[0].attrs.checked).toBe(true);
    expect(node.content[0].content[0].content[0].text).toBe("ship it");
  });

  it("produces an empty paragraph (no text leaf) for empty text", () => {
    const node = checkedLine("") as any;
    expect(node.content[0].content[0].content).toEqual([]);
  });
});

describe("returnItemToNotes", () => {
  const origin = (path: number[], node: any) => ({ path, node });

  it("returns the doc unchanged for a dragged (origin-null) item", () => {
    const doc = paras("a", "b");
    const item: FocusItem = { text: "x", done: false, origin: null };
    expect(returnItemToNotes(doc, item)).toBe(doc);
  });

  it("reinserts the original block verbatim at its path when not done", () => {
    const node = para("write report");
    const item: FocusItem = { text: "write report", done: false, origin: origin([1], node) };
    const out = returnItemToNotes(paras("a", "b"), item) as any;
    expect(out.content.map((n: any) => n.content[0].text)).toEqual(["a", "write report", "b"]);
  });

  it("reinserts as a checked checklist line at the top-level index when done", () => {
    const node = para("write report");
    const item: FocusItem = { text: "write report", done: true, origin: origin([1], node) };
    const out = returnItemToNotes(paras("a", "b"), item) as any;
    expect(out.content[1].type).toBe("taskList");
    expect(out.content[1].content[0].attrs.checked).toBe(true);
    expect(lineText(out.content[1])).toBe("write report");
  });

  it("a done item with a [i,j] origin returns as a top-level checked line at index i", () => {
    const node = { type: "taskItem", attrs: { checked: false }, content: [para("write report")] };
    const item: FocusItem = { text: "write report", done: true, origin: origin([1, 0], node) };
    const out = returnItemToNotes(paras("a", "b"), item) as any;
    expect(out.content[1].type).toBe("taskList");
    expect(out.content[1].content[0].attrs.checked).toBe(true);
  });
});
