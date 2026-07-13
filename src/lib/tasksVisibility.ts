// "Show tasks" preference (Settings toggle): hides/shows the left Tasks block
// (heading + input + list) in App.tsx. Default ON, so existing users with no
// stored value keep seeing tasks. Same localStorage-preference pattern as the
// Spotify player visibility (see spotify.ts) — local persistence, with the
// value also flowing through the settings sync blob in App.tsx.
import { isDemo } from "./demo";

const KEY = "focusbox-show-tasks";

export function getShowTasks(): boolean {
  if (isDemo()) return true;
  return localStorage.getItem(KEY) !== "0";
}

export function storeShowTasks(visible: boolean): void {
  if (isDemo()) return;
  localStorage.setItem(KEY, visible ? "1" : "0");
}
