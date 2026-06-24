import { useEffect, useRef, useState } from "react";
import { initCrypto } from "../lib/crypto";
import { createHttpApi, type FetchImpl } from "../lib/api";
import { SYNC_API_URL } from "../lib/config";
import { isTauri } from "../lib/store";
import { clearSync, loadSync, newDeviceId, saveSync } from "../lib/syncStore";
import {
  SyncManager,
  type LocalSnapshot,
  type MergedSnapshot,
  type SyncSnapshot,
} from "../lib/syncManager";

/** The Tauri http plugin's fetch (Rust-side, no CORS) when in the app; global fetch otherwise. */
async function resolveFetch(): Promise<FetchImpl> {
  if (isTauri) {
    // In the packaged app we MUST use the capability-scoped Tauri http plugin. We do NOT
    // fall back to the webview's global fetch here — that path is unconstrained by the
    // http:* allow-list (CSP is null), so a fallback would defeat the transport scoping.
    // If the import fails (corrupt bundle), let it throw so sync simply doesn't start.
    const mod = await import("@tauri-apps/plugin-http");
    return mod.fetch as FetchImpl;
  }
  return fetch;
}

export interface SyncController extends SyncSnapshot {
  ready: boolean;
  signup: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  syncNow: () => void;
  dismissRecoveryKey: () => void;
  notifyTasksChanged: () => void;
  notifyNotesChanged: (at: number) => void;
  notifySettingsChanged: (at: number) => void;
}

const SIGNED_OUT: SyncSnapshot = {
  status: "signed-out",
  email: null,
  lastSyncedAt: null,
  lastError: null,
  recoveryKey: null,
  hadNotesConflict: false,
};

/**
 * Wires the SyncManager to React. `getLocal` reads the app's current state; `onMerged`
 * applies a merged result back into the app. Both are kept in refs so the manager is
 * constructed once and never sees a stale closure.
 */
export function useSync(args: {
  /** Hold off constructing the manager until the app's local state has hydrated,
   * so the first sync merges against real local data (not the empty initial state). */
  enabled: boolean;
  getLocal: () => LocalSnapshot;
  onMerged: (m: MergedSnapshot) => void;
}): SyncController {
  const [snap, setSnap] = useState<SyncSnapshot>(SIGNED_OUT);
  const [ready, setReady] = useState(false);
  const mgrRef = useRef<SyncManager | null>(null);
  const getLocalRef = useRef(args.getLocal);
  const onMergedRef = useRef(args.onMerged);
  getLocalRef.current = args.getLocal;
  onMergedRef.current = args.onMerged;

  useEffect(() => {
    if (!args.enabled) return;
    let alive = true;
    void (async () => {
      try {
        await initCrypto();
        const fetchImpl = await resolveFetch();
        if (!alive) return;
        const api = createHttpApi(SYNC_API_URL, fetchImpl);
        const mgr = new SyncManager({
          api,
          now: () => Date.now(),
          persist: { load: loadSync, save: saveSync, clear: clearSync, newDeviceId },
          getLocal: () => getLocalRef.current(),
          onMerged: (m) => onMergedRef.current(m),
          onChange: () => {
            if (alive) setSnap(mgr.snapshot());
          },
        });
        mgrRef.current = mgr;
        setReady(true);
        await mgr.init(); // resume a persisted session + initial sync
      } catch (e) {
        // Crypto/transport unavailable (e.g. corrupt bundle): leave sync off rather
        // than starting it on an unsafe path. The rest of the app works offline.
        console.error("Focusbox: cloud sync unavailable.", e);
      }
    })();

    const onFocus = () => {
      void mgrRef.current?.syncNow();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [args.enabled]);

  return {
    ...snap,
    ready,
    signup: (e, p) => mgrRef.current?.signup(e, p) ?? Promise.resolve(),
    login: (e, p) => mgrRef.current?.login(e, p) ?? Promise.resolve(),
    logout: () => mgrRef.current?.logout() ?? Promise.resolve(),
    syncNow: () => void mgrRef.current?.syncNow(),
    dismissRecoveryKey: () => mgrRef.current?.dismissRecoveryKey(),
    notifyTasksChanged: () => mgrRef.current?.notifyTasksChanged(),
    notifyNotesChanged: (at) => mgrRef.current?.notifyNotesChanged(at),
    notifySettingsChanged: (at) => mgrRef.current?.notifySettingsChanged(at),
  };
}
