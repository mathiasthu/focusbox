import "./testDomShim";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// store.ts reads isDemo() at call time; mock it per-test.
vi.mock("./demo", async (orig) => {
  const real = await orig<typeof import("./demo")>();
  return { ...real, isDemo: vi.fn(() => false) };
});

import { loadState, saveState } from "./store";
import * as demo from "./demo";

const LS_KEY = "focusbox-state";

beforeEach(() => {
  localStorage.clear();
  vi.mocked(demo.isDemo).mockReturnValue(false);
});
afterEach(() => localStorage.clear());

describe("store demo branch", () => {
  it("loadState returns curated sample content in demo mode", async () => {
    vi.mocked(demo.isDemo).mockReturnValue(true);
    const s = await loadState();
    expect(s.tasks.length).toBeGreaterThanOrEqual(2);
    expect(s.notesDoc).not.toBeNull();
  });

  it("saveState never touches localStorage in demo mode", async () => {
    vi.mocked(demo.isDemo).mockReturnValue(true);
    const spy = vi.spyOn(Storage.prototype, "setItem");
    saveState({ tasks: [] });
    // flush is debounced; advance time
    await new Promise((r) => setTimeout(r, 600));
    expect(spy).not.toHaveBeenCalled();
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    spy.mockRestore();
  });

  it("non-demo browser path still persists to localStorage", async () => {
    saveState({ tasks: [] });
    await new Promise((r) => setTimeout(r, 600));
    expect(localStorage.getItem(LS_KEY)).not.toBeNull();
  });
});

import { getStoredMode, storeMode } from "./theme";
import { getStoredAccent, storeAccent } from "./accent";
import { getPlayerVisible, storePlayerVisible } from "./spotify";

describe("appearance prefs in demo mode", () => {
  beforeEach(() => vi.mocked(demo.isDemo).mockReturnValue(true));

  it("storeMode/storeAccent/storePlayerVisible write nothing in demo", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    storeMode("dark");
    storeAccent("plum");
    storePlayerVisible(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("getters return defaults in demo (ignore any pre-existing values)", () => {
    localStorage.setItem("focusbox-theme", "dark");
    localStorage.setItem("focusbox-accent", "plum");
    localStorage.setItem("focusbox-player", "0");
    expect(getStoredMode()).toBe("system");
    expect(getStoredAccent()).toBe("clay");
    expect(getPlayerVisible()).toBe(true);
  });
});
