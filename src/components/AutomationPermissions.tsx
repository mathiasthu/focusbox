// macOS Automation permissions (Privacy & Security → Automation): what Focusbox needs, what
// macOS says right now, and how to fix it. Settings shows the full list; the main window
// shows a warning when the focus guard can't read a browser's tabs. The status comes from
// macOS itself (AEDeterminePermissionToAutomateTarget), not from a failed read.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  automationAdvice,
  automationMissing,
  blockedBrowser,
  guardAutomationStatus,
  openAutomationSettings,
  type AutomationTarget,
} from "../lib/focusGuard";

/** Current Automation status, re-checked on focus (back from System Settings) and every
 * minute. Nothing runs while `enabled` is false. */
export function useAutomationStatus(enabled: boolean) {
  const [targets, setTargets] = useState<AutomationTarget[]>([]);
  // Only the newest answer counts: a slow background check must not overwrite the result
  // of a prompt the user just answered.
  const seq = useRef(0);
  const refresh = useCallback(async (askFor?: string) => {
    const id = ++seq.current;
    const next = await guardAutomationStatus(askFor);
    if (id === seq.current) setTargets(next);
    return next;
  }, []);
  useEffect(() => {
    if (!enabled) {
      setTargets([]);
      return;
    }
    let live = true;
    const check = () => {
      const id = ++seq.current;
      void guardAutomationStatus().then((t) => live && id === seq.current && setTargets(t));
    };
    check();
    const timer = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [enabled]);
  return { targets, refresh };
}

/** Never asked: show the macOS prompt. Switched off: only System Settings can undo that. */
async function fix(t: AutomationTarget, refresh: (askFor?: string) => Promise<AutomationTarget[]>) {
  if (t.status === "needs_consent") {
    const after = await refresh(t.bundleId);
    const now = after.find((a) => a.bundleId === t.bundleId);
    if (now && now.status !== "denied") return;
  }
  await openAutomationSettings();
}

const PURPOSE: Record<AutomationTarget["purpose"], string> = {
  browser: "Focus guard reads the open tab",
  spotify: "Mini-player controls playback",
};

const LABEL: Record<AutomationTarget["status"], string> = {
  granted: "Allowed",
  denied: "Off",
  needs_consent: "Not asked yet",
  not_running: "Not running",
  unknown: "Unknown",
};

/** Settings → Focus guard → Permissions. */
export function AutomationPermissions() {
  const { targets, refresh } = useAutomationStatus(true);
  const [busy, setBusy] = useState<string | null>(null);
  if (targets.length === 0) return null;
  return (
    <div className="perm">
      <span className="guard-settings__label">Permissions</span>
      <span className="setting__hint">
        Focusbox needs macOS Automation access to see which site you're on. Without it the focus
        guard can't tell a task's site from a distraction.
      </span>
      <ul className="perm__list">
        {targets.map((t) => {
          const missing = automationMissing(t.status);
          return (
            <li key={t.bundleId} className="perm__item">
              <div className="perm__head">
                <span className="perm__name">{t.name}</span>
                <span className={`perm__status perm__status--${t.status}`}>{LABEL[t.status]}</span>
              </div>
              <span className="perm__why">{PURPOSE[t.purpose]}</span>
              {t.status !== "granted" && <span className="perm__advice">{automationAdvice(t)}</span>}
              {missing && (
                <button
                  type="button"
                  className="btn perm__btn"
                  disabled={busy === t.bundleId}
                  onClick={async () => {
                    setBusy(t.bundleId);
                    try {
                      await fix(t, refresh);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {t.status === "needs_consent" ? "Allow…" : "Open System Settings"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Main window: the focus guard is on but a browser's tabs can't be read. */
export function AutomationWarning({ enabled }: { enabled: boolean }) {
  const { targets, refresh } = useAutomationStatus(enabled);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked = blockedBrowser(targets);
  if (!enabled || hidden || !blocked) return null;
  return (
    <div className="start-prompt perm-warning" role="alert">
      <span className="perm-warning__text">
        <strong>Focus guard can't see your {blocked.name} tabs.</strong>
        <span className="perm-warning__advice">{automationAdvice(blocked)}</span>
      </span>
      <span className="start-prompt__actions">
        <button
          type="button"
          className="btn btn--primary start-prompt__btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await fix(blocked, refresh);
            } finally {
              setBusy(false);
            }
          }}
        >
          {blocked.status === "needs_consent" ? "Allow" : "Open Settings"}
        </button>
        <button type="button" className="btn start-prompt__btn" onClick={() => setHidden(true)}>
          Later
        </button>
      </span>
    </div>
  );
}
