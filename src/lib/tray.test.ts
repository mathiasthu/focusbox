import "./testDomShim";
import { describe, expect, it } from "vitest";
import { trayTitleFor, isTrayAvailable, initTray, setTrayTitle, destroyTray } from "./tray";

describe("trayTitleFor (display-string derivation)", () => {
  it("idle (\"set timer\") -> null (icon only)", () => {
    expect(trayTitleFor("set timer", 30 * 60 * 1000)).toBeNull();
  });
  it("running (\"focusing\") -> mm:ss", () => {
    expect(trayTitleFor("focusing", 24 * 60 * 1000 + 31 * 1000)).toBe("24:31");
  });
  it("running rounds up partial seconds", () => {
    expect(trayTitleFor("focusing", 1500)).toBe("0:02");
  });
  it("running past the hour mark includes h:mm:ss", () => {
    expect(trayTitleFor("focusing", 61 * 60 * 1000)).toBe("1:01:00");
  });
  it("paused -> frozen \"⏸ mm:ss\"", () => {
    expect(trayTitleFor("paused", 24 * 60 * 1000 + 31 * 1000)).toBe("⏸ 24:31");
  });
  it("finished (\"time's up\") -> static \"0:00\"", () => {
    expect(trayTitleFor("time's up", 0)).toBe("0:00");
    // Static regardless of any lingering remainingMs value.
    expect(trayTitleFor("time's up", 5000)).toBe("0:00");
  });
});

describe("tray availability + no-op guards (off-Tauri / jsdom)", () => {
  it("is unavailable in the vitest/jsdom environment (no Tauri bridge)", () => {
    expect(isTrayAvailable).toBe(false);
  });
  it("all tray functions no-op without throwing off-Tauri", async () => {
    await expect(initTray()).resolves.toBeUndefined();
    await expect(setTrayTitle("24:31")).resolves.toBeUndefined();
    await expect(setTrayTitle(null)).resolves.toBeUndefined();
    await expect(destroyTray()).resolves.toBeUndefined();
  });
});
