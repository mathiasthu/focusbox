// Thin wrapper around the macOS menubar (tray) live-countdown item. Mirrors the
// degrade-silently philosophy of spotify.ts: outside the Tauri desktop app (plain
// browser / dev preview / vitest) or on non-macOS, every function is a no-op so the
// rest of the app never has to guard tray calls.

// True inside the Tauri webview; false in a plain browser (dev preview / vitest).
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Menubar title text only renders on macOS (Windows tray items can't show inline
// title text) — same platform check as the Spotify player (see spotify.ts).
const isMac =
  typeof navigator !== "undefined" && /\bMac/i.test(navigator.userAgent || "");

export const isTrayAvailable = isTauri && isMac;

const TRAY_ID = "focusbox-timer";

// Bundled by Vite; fetched at runtime and passed to the tray as raw PNG bytes.
// (A bare "icons/tray.png" path string would be resolved by the Rust side
// against the process cwd, which doesn't contain it in a production bundle.)
import trayIconUrl from "../assets/tray.png";

function formatMmSs(totalSec: number): string {
  const s = Math.max(0, totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Pure derivation of the tray title from Timer's own `status` string + the
// current remainingMs — kept here (not in Timer.tsx) so it's unit-testable
// without touching React, and so Timer stays unaware of the tray entirely.
// idle ("set timer") -> null (icon only); running ("focusing") -> "mm:ss";
// paused -> "⏸ mm:ss" (frozen, whatever remainingMs was at pause time);
// finished ("time's up") -> "0:00".
export function trayTitleFor(status: string, remainingMs: number): string | null {
  switch (status) {
    case "focusing":
      return formatMmSs(Math.ceil(remainingMs / 1000));
    case "paused":
      return `⏸ ${formatMmSs(Math.ceil(remainingMs / 1000))}`;
    case "time's up":
      return "0:00";
    default:
      return null;
  }
}

// Cached across calls: `set` no-ops if the app calls setTrayTitle with the same
// text back-to-back (e.g. a frozen "paused" title on every parent re-render).
let lastTitle = "";
let trayHandle: unknown = null;

export async function initTray(): Promise<void> {
  if (!isTrayAvailable) return;
  try {
    const { TrayIcon } = await import("@tauri-apps/api/tray");
    const existing = await TrayIcon.getById(TRAY_ID);
    if (existing) {
      trayHandle = existing;
      lastTitle = "";
      return;
    }
    const { Image } = await import("@tauri-apps/api/image");
    const bytes = new Uint8Array(await (await fetch(trayIconUrl)).arrayBuffer());
    trayHandle = await TrayIcon.new({
      id: TRAY_ID,
      icon: await Image.fromBytes(bytes),
      iconAsTemplate: true,
      title: "",
      action: async (event) => {
        if (event.type !== "Click") return;
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          await win.unminimize();
          await win.show();
          await win.setFocus();
        } catch (err) {
          console.error("Focusbox: tray click focus failed", err);
        }
      },
    });
    lastTitle = "";
  } catch (err) {
    console.error("Focusbox: tray init failed", err);
    trayHandle = null;
  }
}

export async function setTrayTitle(text: string | null): Promise<void> {
  if (!isTrayAvailable || !trayHandle) return;
  const next = text ?? "";
  if (next === lastTitle) return;
  try {
    await (trayHandle as { setTitle: (t: string | null) => Promise<void> }).setTitle(text);
    lastTitle = next;
  } catch (err) {
    console.error("Focusbox: tray setTitle failed", err);
  }
}

export async function destroyTray(): Promise<void> {
  if (!isTrayAvailable) return;
  try {
    const { TrayIcon } = await import("@tauri-apps/api/tray");
    await TrayIcon.removeById(TRAY_ID);
  } catch (err) {
    console.error("Focusbox: tray destroy failed", err);
  } finally {
    trayHandle = null;
    lastTitle = "";
  }
}
