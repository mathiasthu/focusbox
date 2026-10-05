// The park confirmation: a small pill at the top centre of the screen. Rendered instead of
// <App/> in the click-through, never-focused window Rust opens at index.html?view=toast
// (src-tauri/src/toast.rs). Rust owns the window's lifetime; this page only fades in, waits
// `durationMs`, and fades out. A newer park bumps `seq` and restarts that.
//
// Its capability (capabilities/toast.json) grants only `get_toast_state` and event listen.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toastCopy, truncateForToast } from "../lib/focusGuard";

interface ToastPayload {
  seq: number;
  result: string;
  text: string;
  durationMs: number;
}

export default function Toast() {
  const [payload, setPayload] = useState<ToastPayload | null>(null);
  const [shown, setShown] = useState(false);

  const load = useCallback(async () => {
    try {
      setPayload(await invoke<ToastPayload | null>("get_toast_state"));
    } catch {
      setPayload(null);
    }
  }, []);

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    let dead = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("toast://refresh", () => void load()))
      .then((u) => {
        if (dead) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      dead = true;
      unlisten?.();
    };
  }, [load]);

  // Fade in on the next frame (so the transition runs), out after durationMs. Under
  // prefers-reduced-motion the CSS drops the transition, so this is a plain show/hide.
  const seq = payload?.seq;
  const duration = payload?.durationMs ?? 0;
  useEffect(() => {
    if (seq === undefined) return;
    const raf = requestAnimationFrame(() => setShown(true));
    const t = window.setTimeout(() => setShown(false), duration);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [seq, duration]);

  if (!payload) return null;
  const copy = toastCopy(payload.result);
  const line = truncateForToast(payload.text);

  return (
    <div className={`toast${shown ? " toast--shown" : ""}${copy.ok ? "" : " toast--warn"}`} role="status" aria-live="polite">
      <span className="toast__icon" aria-hidden="true">
        {copy.ok ? "✓" : "!"}
      </span>
      <span className="toast__body">
        <span className="toast__title">{copy.title}</span>
        {line && <span className="toast__text">{line}</span>}
      </span>
    </div>
  );
}
