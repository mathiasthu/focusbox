import { getStore, isTauri } from "./store";
import { emptySyncState, type SyncState } from "./sync";

/**
 * Everything needed to resume sync after a relaunch without re-entering the password.
 * The ADK (base64) is stored locally on purpose — see the note in crypto.ts: local
 * data is already plaintext on disk, and this never leaves the device, so server-side
 * zero-knowledge is unaffected.
 */
export interface SyncPersist {
  email: string;
  accessToken: string;
  refreshToken: string;
  adk: string; // base64
  deviceId: string;
  state: SyncState;
  settingsUpdatedAt: number;
  notesUpdatedAt: number;
}

const STORE_KEY = "sync"; // Tauri plugin-store key (in focusbox.json)
const LS_KEY = "focusbox-sync"; // browser fallback

export async function loadSync(): Promise<SyncPersist | null> {
  try {
    if (isTauri) {
      const store = await getStore();
      return (await store.get<SyncPersist>(STORE_KEY)) ?? null;
    }
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as SyncPersist) : null;
  } catch (err) {
    console.error("Focusbox: failed to load sync identity.", err);
    return null;
  }
}

export async function saveSync(p: SyncPersist): Promise<void> {
  // Deliberately does NOT swallow errors: a failed write must be visible to the
  // caller so a sync isn't reported as durable when the on-disk state wasn't saved.
  if (isTauri) {
    const store = await getStore();
    await store.set(STORE_KEY, p);
    await store.save();
    return;
  }
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}

export async function clearSync(): Promise<void> {
  try {
    if (isTauri) {
      const store = await getStore();
      await store.delete(STORE_KEY);
      await store.save();
      return;
    }
    localStorage.removeItem(LS_KEY);
  } catch (err) {
    console.error("Focusbox: failed to clear sync identity.", err);
  }
}

/** A stable per-device id used to label pushes + scope notes-conflict keys. */
export function newDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function freshState(): SyncState {
  return emptySyncState();
}
