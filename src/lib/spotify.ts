// Thin wrapper around the Rust Spotify commands. In a plain browser (dev
// preview) or on non-macOS there's no Tauri bridge, so everything degrades to
// an "unavailable" player rather than throwing.

export type SpotifyStatus = "playing" | "paused" | "stopped" | "unavailable";
export type SpotifyAction = "playpause" | "next" | "previous";

export interface SpotifyState {
  status: SpotifyStatus;
  track?: string;
  artist?: string;
}

const UNAVAILABLE: SpotifyState = { status: "unavailable" };

// True inside the Tauri webview; false in a plain browser (dev preview).
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function getSpotifyState(): Promise<SpotifyState> {
  if (!isTauri) return UNAVAILABLE;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<SpotifyState>("spotify_state");
  } catch (err) {
    console.error("Focusbox: spotify_state failed", err);
    return UNAVAILABLE;
  }
}

export async function spotifyControl(action: SpotifyAction): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("spotify_control", { action });
  } catch (err) {
    // e.g. Spotify not running — the next state poll reflects reality.
    console.error("Focusbox: spotify_control failed", err);
  }
}

// ---- Player visibility preference (default on) ----

const KEY = "focusbox-player";

export function getPlayerVisible(): boolean {
  return localStorage.getItem(KEY) !== "0";
}

export function storePlayerVisible(visible: boolean): void {
  localStorage.setItem(KEY, visible ? "1" : "0");
}
