import "./testDomShim";
import { afterEach, describe, expect, it } from "vitest";
import { getChime, storeChime, playChime } from "./chime";

const KEY = "focusbox-chime";

afterEach(() => {
  localStorage.removeItem(KEY);
  window.history.replaceState({}, "", "/");
});

describe("timer sound preference", () => {
  it("defaults to OFF when nothing is stored (never surprise an existing user with sound)", () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getChime()).toBe(false);
  });

  it("persists ON and reads it back", () => {
    storeChime(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    expect(getChime()).toBe(true);
  });

  it("persists OFF explicitly and reads it back", () => {
    storeChime(true);
    storeChime(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    expect(getChime()).toBe(false);
  });

  it("is off in demo mode regardless of stored value, and does not write", () => {
    storeChime(true);
    window.history.replaceState({}, "", "/demo");
    expect(getChime()).toBe(false);
    storeChime(false);
    // demo mode never writes — the earlier "1" from before entering demo mode remains.
    expect(localStorage.getItem(KEY)).toBe("1");
  });
});

describe("playChime", () => {
  it("no-ops instead of throwing when WebAudio is unavailable", () => {
    expect("AudioContext" in window).toBe(false);
    expect(() => playChime()).not.toThrow();
  });
});
