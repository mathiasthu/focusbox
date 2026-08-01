import "./testDomShim";
import { describe, expect, it } from "vitest";
import { isAutostartAvailable, getAutostartEnabled, setAutostartEnabled } from "./autostart";

describe("autostart availability + no-op guards (off-Tauri / jsdom)", () => {
  it("is unavailable in the vitest/jsdom environment (no Tauri bridge)", () => {
    expect(isAutostartAvailable).toBe(false);
  });

  it("reads as off rather than throwing off-Tauri", async () => {
    await expect(getAutostartEnabled()).resolves.toBe(false);
  });

  it("toggling off-Tauri is a no-op that reports back off, not the requested value", async () => {
    // Important: the return value is the state that actually took effect, so a
    // caller adopting it can never end up showing "On" for a machine that isn't
    // registered.
    await expect(setAutostartEnabled(true)).resolves.toBe(false);
    await expect(setAutostartEnabled(false)).resolves.toBe(false);
  });
});
