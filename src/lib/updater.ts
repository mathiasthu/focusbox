// Auto-update (desktop app only). Checks GitHub Releases for a newer, signed build
// on launch; the UI then offers a "restart to update" prompt. No-ops in the browser
// preview (the plugins only exist inside the Tauri shell).
import type { Update } from "@tauri-apps/plugin-updater";

const isTauri = "__TAURI_INTERNALS__" in window;

export interface UpdateInfo {
  version: string;
  notes?: string;
}

// Keep the resolved Update around so install() reuses this check (no second round-trip
// and no risk of racing a different result).
let pending: Update | null = null;

/** Check for an available update. Returns its info, or null (incl. in the browser). */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update?.available) {
      pending = update;
      return { version: update.version, notes: update.body || undefined };
    }
  } catch (e) {
    // Offline / GitHub unreachable / no release yet — never block app startup on it.
    console.error("Focusbox: update check failed.", e);
  }
  return null;
}

/** Download + install the pending update, then relaunch to apply it. */
export async function installUpdateAndRestart(): Promise<void> {
  if (!pending) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await pending.downloadAndInstall();
  await relaunch();
}
