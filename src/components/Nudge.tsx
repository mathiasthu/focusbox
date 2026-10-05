// The focus guard's full-screen nudge. Rendered instead of <App/> in the borderless
// window Rust opens at index.html?view=nudge (see focusguard.rs). It fetches what to show
// from Rust on mount, and again whenever Rust re-raises the window. Every answer goes back
// through `nudge_resolve`; Rust closes this window itself once it's handled.
//
// This window's capability (capabilities/nudge.json) grants only those two commands plus
// event listening — no store, sync or Todoist-key access.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  applyNudgeOpacity,
  getNudgeOpacity,
  isValidReason,
  MIN_REASON_CHARS,
  NUDGE_OPACITY_KEY,
  parkResultMessage,
} from "../lib/focusGuard";
import { applyTheme, getStoredMode } from "../lib/theme";

interface NudgePayload {
  kind: "drift" | "preview";
  task: string;
  label: string | null;
  appName: string | null;
  domain: string | null;
  driftCount: number;
  reasonRequired: boolean;
  minReasonChars: number;
}

type Mode = "main" | "park" | "switch";

export default function Nudge() {
  const [state, setState] = useState<NudgePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>("main");
  const [reason, setReason] = useState("");
  const [parkText, setParkText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  // Same theme as the main window: main.tsx already applied the stored mode before the
  // first paint. Keep following it while the nudge is up: macOS switching light/dark
  // (for "system"), or the setting changing in the main window (same-origin storage).
  // The tint strength (Settings → "Nudge opacity"). Re-read on `storage` events so the
  // slider moves a preview live, plus a 1s re-read as a backstop in case storage events
  // don't cross between this window and the main one.
  useEffect(() => {
    const root = document.documentElement;
    let last = -1;
    const sync = () => {
      const p = getNudgeOpacity();
      if (p !== last) {
        last = p;
        applyNudgeOpacity(root, p);
      }
    };
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === NUDGE_OPACITY_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(sync, 1000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const sync = () => applyTheme(getStoredMode());
    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    mql?.addEventListener("change", sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "focusbox-theme") sync();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      mql?.removeEventListener("change", sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await invoke<NudgePayload | null>("get_nudge_state");
      setState(s);
      setMode("main");
      setReason("");
      setError(null);
      setBusy(false);
      setParkText(s?.label ?? "");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  // This window is created once and reused (never destroyed: see focusguard.rs WinOp).
  // Rust sends "nudge://refresh" before every show: re-fetch and start from a clean UI
  // (load() resets the reason, park view, busy flag and error). "nudge://reset" comes
  // with every hide, so the next show never flashes the previous answer.
  useEffect(() => {
    void load();
    const unlisteners: (() => void)[] = [];
    let dead = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        Promise.all([
          listen("nudge://refresh", () => void load()),
          listen("nudge://reset", () => {
            setState(null);
            setMode("main");
            setReason("");
            setParkText("");
            setBusy(false);
            setError(null);
            setLoaded(false);
          }),
        ]),
      )
      .then((us) => {
        if (dead) us.forEach((u) => u());
        else unlisteners.push(...us);
      })
      .catch(() => {});
    return () => {
      dead = true;
      unlisteners.forEach((u) => u());
    };
  }, [load]);

  useEffect(() => {
    if (mode !== "main" || state?.reasonRequired) reasonRef.current?.focus();
  }, [mode, state]);

  async function resolve(action: string, extra: { reason?: string; text?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<string>("nudge_resolve", {
        action,
        reason: extra.reason ?? null,
        text: extra.text ?? null,
      });
      if (action === "park") {
        // Rust closes the window right after; this only shows if it lingers.
        setError(parkResultMessage(r) || null);
      }
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  if (!loaded) return <div className="nudge" />;

  if (!state) {
    return (
      <div className="nudge">
        <div className="nudge__panel">
          <p className="nudge__eyebrow">Focus guard</p>
          <p className="nudge__sub">Nothing to answer here.</p>
          <div className="nudge__actions">
            <button className="nudge__btn nudge__btn--primary" disabled={busy} onClick={() => void resolve("close")}>
              Close
            </button>
          </div>
          {error && <p className="nudge__error">{error}</p>}
        </div>
      </div>
    );
  }

  if (state.kind === "preview") {
    // Settings → "Preview nudge". Rust keeps this out of the drift machine and the log.
    return (
      <div className="nudge">
        <div className="nudge__panel">
          <p className="nudge__eyebrow">
            Preview · You drifted to <strong>{state.label ?? "Example site"}</strong>
          </p>
          <h1 className="nudge__task">{state.task || "Your task"}</h1>
          <p className="nudge__sub">This is how the reminder looks. Adjust it in Settings, Focus guard.</p>
          <div className="nudge__actions">
            <button className="nudge__btn nudge__btn--primary" disabled={busy} onClick={() => void resolve("close")}>
              Close preview
            </button>
          </div>
          {error && <p className="nudge__error">{error}</p>}
        </div>
      </div>
    );
  }

  const label = state.label ?? state.appName ?? "another app";
  const min = state.minReasonChars || MIN_REASON_CHARS;
  const reasonOk = isValidReason(reason);
  // Escalation: from the 2nd drift of a task session, every way out (back, park, allow)
  // needs a typed reason. Rust enforces the same rule.
  const needsReason = state.reasonRequired;
  const blocked = needsReason && !reasonOk;
  const reasonArg = needsReason ? reason : undefined;
  const reasonField = (
    <label className="nudge__field">
      <span>Why did you leave? ({min}+ characters)</span>
      <textarea
        ref={reasonRef}
        className="nudge__input"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </label>
  );

  return (
    <div className="nudge">
      <div className="nudge__panel">
        <p className="nudge__eyebrow">
          You drifted to <strong>{label}</strong>
          {state.driftCount > 1 && ` · drift ${state.driftCount} on this task`}
        </p>
        <h1 className="nudge__task">{state.task || "Your task"}</h1>

        {mode === "main" && (
          <>
            {needsReason && reasonField}
            <div className="nudge__actions">
              <button
                className="nudge__btn nudge__btn--primary"
                disabled={busy || blocked}
                onClick={() => void resolve("back", { reason: reasonArg })}
              >
                Back to task
              </button>
              <button className="nudge__btn" disabled={busy} onClick={() => setMode("park")}>
                Park it
              </button>
              <button className="nudge__btn" disabled={busy} onClick={() => setMode("switch")}>
                Switch with reason
              </button>
            </div>
            <button
              className="nudge__link"
              disabled={busy || blocked}
              onClick={() => void resolve("allow", { reason: reasonArg })}
            >
              Allow {label} for this task
            </button>
          </>
        )}

        {mode === "park" && (
          <>
            <label className="nudge__field">
              <span>What pulled you away? It goes to Todoist so you can drop it for now.</span>
              <input
                className="nudge__input"
                autoFocus={!needsReason}
                value={parkText}
                onChange={(e) => setParkText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && parkText.trim() && !busy && !blocked)
                    void resolve("park", { text: parkText, reason: reasonArg });
                }}
              />
            </label>
            {needsReason && reasonField}
            <div className="nudge__actions">
              <button
                className="nudge__btn nudge__btn--primary"
                disabled={busy || !parkText.trim() || blocked}
                onClick={() => void resolve("park", { text: parkText, reason: reasonArg })}
              >
                {busy ? "Parking…" : "Park it and go back"}
              </button>
              <button className="nudge__btn" disabled={busy} onClick={() => setMode("main")}>
                Cancel
              </button>
            </div>
          </>
        )}

        {mode === "switch" && (
          <>
            <label className="nudge__field">
              <span>Why switch? ({min}+ characters)</span>
              <textarea
                ref={reasonRef}
                className="nudge__input"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="nudge__actions">
              <button
                className="nudge__btn nudge__btn--primary"
                disabled={busy || !reasonOk}
                onClick={() => void resolve("switch", { reason })}
              >
                Switch and clear the task
              </button>
              <button className="nudge__btn" disabled={busy} onClick={() => setMode("main")}>
                Cancel
              </button>
            </div>
          </>
        )}

        {error && <p className="nudge__error">{error}</p>}
      </div>
    </div>
  );
}
