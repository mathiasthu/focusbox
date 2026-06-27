import { describe, it, expect } from "vitest";
import { appendTaskLines } from "./notesEdit";

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("appendTaskLines", () => {
  it("creates a fresh doc from a null doc", () => {
    expect(appendTaskLines(null, ["one", "two"])).toEqual({
      type: "doc",
      content: [para("one"), para("two")],
    });
  });

  it("appends to an existing doc, preserving prior content", () => {
    const doc = { type: "doc", content: [para("keep")] };
    expect(appendTaskLines(doc, ["new"])).toEqual({
      type: "doc",
      content: [para("keep"), para("new")],
    });
  });

  it("trims a trailing empty paragraph so lines don't accumulate blank gaps", () => {
    const doc = { type: "doc", content: [para("keep"), { type: "paragraph" }] };
    expect(appendTaskLines(doc, ["new"])).toEqual({
      type: "doc",
      content: [para("keep"), para("new")],
    });
  });

  it("treats an all-empty doc as empty (no leading blank line)", () => {
    const doc = { type: "doc", content: [{ type: "paragraph" }] };
    expect(appendTaskLines(doc, ["only"])).toEqual({
      type: "doc",
      content: [para("only")],
    });
  });

  it("drops blank/whitespace-only lines and trims each line", () => {
    expect(appendTaskLines(null, ["  a  ", "", "   ", "b"])).toEqual({
      type: "doc",
      content: [para("a"), para("b")],
    });
  });

  it("returns the doc unchanged when there are no usable lines", () => {
    const doc = { type: "doc", content: [para("keep")] };
    expect(appendTaskLines(doc, ["", "   "])).toBe(doc);
  });

  it("falls back to a fresh doc for a malformed doc value", () => {
    expect(appendTaskLines({ foo: "bar" } as never, ["x"])).toEqual({
      type: "doc",
      content: [para("x")],
    });
  });
});
