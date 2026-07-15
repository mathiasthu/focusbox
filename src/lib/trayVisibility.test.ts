import "./testDomShim";
import { afterEach, describe, expect, it } from "vitest";
import { getMenubarTimer, storeMenubarTimer } from "./trayVisibility";

const KEY = "focusbox-menubar-timer";

afterEach(() => {
  localStorage.removeItem(KEY);
  window.history.replaceState({}, "", "/");
});

describe("menubar timer preference", () => {
  it("defaults to ON when nothing is stored (existing users keep the tray)", () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getMenubarTimer()).toBe(true);
  });

  it("persists OFF and reads it back", () => {
    storeMenubarTimer(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    expect(getMenubarTimer()).toBe(false);
  });

  it("persists ON explicitly and reads it back", () => {
    storeMenubarTimer(false);
    storeMenubarTimer(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    expect(getMenubarTimer()).toBe(true);
  });

  it("is true in demo mode regardless of stored value, and does not write", () => {
    storeMenubarTimer(false);
    window.history.replaceState({}, "", "/demo");
    expect(getMenubarTimer()).toBe(true);
    storeMenubarTimer(true);
    // demo mode never writes — the earlier "0" from before entering demo mode remains.
    expect(localStorage.getItem(KEY)).toBe("0");
  });
});
