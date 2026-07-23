import "./testDomShim";
import { afterEach, describe, expect, it } from "vitest";
import { getPinned, storePinned, MAX_PINS } from "./toolbarPins";

const KEY = "focusbox-toolbar-pins";

afterEach(() => {
  localStorage.removeItem(KEY);
  window.history.replaceState({}, "", "/");
});

describe("toolbar pins preference", () => {
  it("defaults to no pins when nothing is stored", () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getPinned()).toEqual([]);
  });

  it("round-trips a pin list", () => {
    storePinned(["bold", "strike"]);
    expect(getPinned()).toEqual(["bold", "strike"]);
  });

  it("drops unknown ids on read (future renames stay safe)", () => {
    localStorage.setItem(KEY, JSON.stringify(["bold", "underline", "h1"]));
    expect(getPinned()).toEqual(["bold", "h1"]);
  });

  it("drops duplicate ids on read", () => {
    localStorage.setItem(KEY, JSON.stringify(["bold", "bold", "h2"]));
    expect(getPinned()).toEqual(["bold", "h2"]);
  });

  it("truncates to the pin cap on read and write", () => {
    localStorage.setItem(KEY, JSON.stringify(["h1", "h2", "bold"]));
    expect(getPinned()).toEqual(["h1", "h2"]);
    expect(getPinned().length).toBe(MAX_PINS);
    storePinned(["bullet", "ordered", "task"] as never);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["bullet", "ordered"]);
  });

  it("returns [] for corrupt JSON and non-array JSON", () => {
    localStorage.setItem(KEY, "not json{");
    expect(getPinned()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ bold: true }));
    expect(getPinned()).toEqual([]);
  });

  it("is [] in demo mode regardless of stored value, and does not write", () => {
    storePinned(["bold"]);
    window.history.replaceState({}, "", "/demo");
    expect(getPinned()).toEqual([]);
    storePinned(["strike"]);
    // demo mode never writes — the pre-demo value remains.
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["bold"]);
  });
});
