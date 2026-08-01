// Thin wrapper around the "launch at login" plugin (macOS LaunchAgent plist /
// Windows HKCU Run key). Same degrade-silently philosophy as tray.ts: outside the
// Tauri desktop app (plain browser / dev preview / vitest) every function is a
// no-op so the rest of the app never has to guard autostart calls.
//
// Unlike every other Settings toggle, this one is NOT persisted in localStorage and
// NOT part of the settings sync blob: the OS registration IS the state. Storing a
// second copy would drift the moment the user removes the login item from System
// Settings / Task Manager, and syncing it would silently register a machine the
// user never asked to autostart. So: read the truth from the OS on mount, write
// straight through on toggle.

import { isDemo } from "./demo";

// True inside the Tauri webview; false in a plain browser (dev preview / vitest).
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Desktop-only: the plugin is registered under `#[cfg(desktop)]`, and there is no
// login concept to hook in the browser build (app.focusbox.net). Demo mode never
// touches the machine.
export const isAutostartAvailable = isTauri && !isDemo();

/** Whether the app is currently registered to launch at login. False (and never
 *  throws) when unavailable, or if the OS lookup fails. */
export async function getAutostartEnabled(): Promise<boolean> {
  if (!isAutostartAvailable) return false;
  try {
    const { isEnabled } = await import("@tauri-apps/plugin-autostart");
    return await isEnabled();
  } catch (err) {
    console.error("Focusbox: autostart lookup failed", err);
    return false;
  }
}

/** Register / unregister the app with the OS login items. Resolves to the state
 *  that actually took effect, so a failed write can be reflected back in the UI
 *  instead of leaving the toggle lying about the machine. */
export async function setAutostartEnabled(next: boolean): Promise<boolean> {
  if (!isAutostartAvailable) return false;
  try {
    const { enable, disable, isEnabled } = await import("@tauri-apps/plugin-autostart");
    // enable() on an already-registered app (and disable() on an unregistered one)
    // is an error on some platforms, so only write when it's an actual change.
    if ((await isEnabled()) !== next) {
      if (next) await enable();
      else await disable();
    }
    return await isEnabled();
  } catch (err) {
    console.error("Focusbox: autostart toggle failed", err);
    // Report what the OS actually has, not what was asked for.
    return await getAutostartEnabled();
  }
}
