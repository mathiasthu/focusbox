// The focus guard's full-screen nudge. Rendered instead of <App/> in the borderless
// window Rust opens at index.html?view=nudge (see focusguard.rs). It fetches what to show
// from Rust on mount, and again whenever Rust re-raises the window. Every answer goes back
// through `nudge_resolve`; Rust closes this window itself once it's handled.
//
// This window's capability (capabilities/nudge.json) grants only those two commands plus
// event listening — no store, sync or Todoist-key access.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isValidReason, MIN_REASON_CHARS, parkResultMessage } from "../lib/focusGuard";

interface NudgePayload {
  kind: "drift" | "needTask";
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

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    let dead = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("guard://nudge-refresh", () => void load()))
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

  if (state.kind === "needTask") {
    return (
      <div className="nudge">
        <div className="nudge__panel">
          <p className="nudge__eyebrow">Focus guard</p>
          <h1 className="nudge__task">No task running</h1>
          <p className="nudge__sub">It's your work time. Pick one thing and start the timer.</p>
          <div className="nudge__actions">
            <button className="nudge__btn nudge__btn--primary" disabled={busy} onClick={() => void resolve("open_main")}>
              Open Focusbox
            </button>
            <button className="nudge__btn" disabled={busy} onClick={() => void resolve("snooze")}>
              Not now (10 min)
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
