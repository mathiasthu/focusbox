// "Menubar timer" preference (Settings toggle): shows/hides the macOS tray
// (menubar) live-countdown item. Default ON, so existing users with no
// stored value get the tray. Same localStorage-preference pattern as
// tasksVisibility.ts / the Spotify player visibility (spotify.ts) — local
// persistence, with the value also flowing through the settings sync blob
// in App.tsx.
import { isDemo } from "./demo";

const KEY = "focusbox-menubar-timer";

export function getMenubarTimer(): boolean {
  if (isDemo()) return true;
  return localStorage.getItem(KEY) !== "0";
}

export function storeMenubarTimer(visible: boolean): void {
  if (isDemo()) return;
  localStorage.setItem(KEY, visible ? "1" : "0");
}
