// Settings → "Focus guard" (macOS desktop only; Settings renders this only when the Rust
// side reports the guard as supported). Device-local: stored in localStorage via
// focusGuard.ts, never in the settings sync blob.
import { useEffect, useState } from "react";
import {
  getNudgeOpacity,
  GRACE_OPTIONS,
  NUDGE_OPACITY_MAX,
  NUDGE_OPACITY_MIN,
  NUDGE_OPACITY_STEP,
  previewNudge,
  storeNudgeOpacity,
  todoistClearToken,
  todoistSetToken,
  todoistStatus,
  type GuardPrefs,
  type TodoistStatus,
} from "../lib/focusGuard";

interface Props {
  prefs: GuardPrefs;
  onChange: (next: GuardPrefs) => void;
  onOpenStats: () => void;
  /** The current Focus card's text, for "Preview nudge" ("" when there is none). */
  previewTask: string;
}

function OnOff({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      <button
        type="button"
        className={`segmented__opt${value ? " segmented__opt--active" : ""}`}
        aria-pressed={value}
        onClick={() => onChange(true)}
      >
        On
      </button>
      <button
        type="button"
        className={`segmented__opt${!value ? " segmented__opt--active" : ""}`}
        aria-pressed={!value}
        onClick={() => onChange(false)}
      >
        Off
      </button>
    </div>
  );
}

const KEY_MESSAGES: Record<string, string> = {
  ok: "Connected",
  invalid: "Invalid key",
  offline: "Offline, saved",
};

function TodoistKey() {
  const [status, setStatus] = useState<TodoistStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => void todoistStatus().then(setStatus);
  useEffect(refresh, []);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await todoistSetToken(draft);
      setMessage(KEY_MESSAGES[r] ?? r);
      if (r !== "invalid") setDraft("");
    } catch (err) {
      setMessage(`Couldn't save the key: ${String(err)}`);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    try {
      await todoistClearToken();
      setMessage("Removed");
    } catch (err) {
      setMessage(`Couldn't remove the key: ${String(err)}`);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const state = !status
    ? ""
    : status.authBlocked
      ? "Todoist refused the saved key"
      : status.configured
        ? "Key saved"
        : "No key saved";

  return (
    <div className="guard-settings__todoist">
      <span className="setting__label">Todoist API key</span>
      <div className="account__row guard-settings__keyrow">
        <input
          className="account__input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={status?.configured ? "Paste a new key to replace it" : "Paste your API key"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim() && !busy) void save();
          }}
          aria-label="Todoist API key"
        />
        <button
          type="button"
          className="account__btn account__btn--primary"
          disabled={busy || !draft.trim()}
          onClick={() => void save()}
        >
          Save
        </button>
        {status?.configured && (
          <button type="button" className="account__btn" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
      </div>
      <span className={`account__status${message === "Invalid key" ? " account__status--error" : ""}`}>
        {message ?? state}
        {status && status.queued > 0 && ` · ${status.queued} waiting to send`}
      </span>
      <span className="setting__hint">
        Parked tasks go to your Todoist Inbox with the label "parked". Find the key in Todoist under
        Settings, Integrations, Developer. It is kept in your Keychain, not in Focusbox.
      </span>
    </div>
  );
}

/** "Nudge opacity", "Blur behind nudge" and "Preview nudge". Shown whether or not the
 * guard is on, so the look can be tuned first. */
function NudgeLook({ prefs, onChange, previewTask }: Pick<Props, "prefs" | "onChange" | "previewTask">) {
  const [opacity, setOpacity] = useState(getNudgeOpacity);
  const [note, setNote] = useState<string | null>(null);

  async function preview() {
    setNote(null);
    try {
      const r = await previewNudge(previewTask, prefs.blur);
      if (r === "real_nudge_open") setNote("A real reminder is open right now.");
    } catch (err) {
      setNote(`Couldn't open the preview: ${String(err)}`);
    }
  }

  return (
    <>
      <div className="setting__row">
        <span className="guard-settings__label">Nudge opacity</span>
        <div className="guard-settings__range">
          <input
            type="range"
            min={NUDGE_OPACITY_MIN}
            max={NUDGE_OPACITY_MAX}
            step={NUDGE_OPACITY_STEP}
            value={opacity}
            aria-label="Nudge opacity"
            aria-valuetext={`${opacity}%`}
            onChange={(e) => {
              const v = Number(e.target.value);
              setOpacity(v);
              storeNudgeOpacity(v);
            }}
          />
          <span className="guard-settings__value">{opacity}%</span>
        </div>
      </div>
      <div className="setting__row">
        <span className="guard-settings__label">Blur behind nudge</span>
        <OnOff label="Blur behind nudge" value={prefs.blur} onChange={(v) => onChange({ ...prefs, blur: v })} />
      </div>
      <div className="setting__row">
        <span className="setting__hint">Lower opacity shows more of your screen behind the reminder.</span>
        <button type="button" className="account__btn" onClick={() => void preview()}>
          Preview nudge
        </button>
      </div>
      {note && <span className="account__status">{note}</span>}
    </>
  );
}

export default function FocusGuardSettings({ prefs, onChange, onOpenStats, previewTask }: Props) {
  const set = (patch: Partial<GuardPrefs>) => onChange({ ...prefs, ...patch });
  const setWorkday = (patch: Partial<GuardPrefs["workday"]>) =>
    onChange({ ...prefs, workday: { ...prefs.workday, ...patch } });

  return (
    <div className="setting setting--col guard-settings">
      <div className="setting__row">
        <span className="setting__label">Focus guard</span>
        <OnOff label="Focus guard" value={prefs.enabled} onChange={(v) => set({ enabled: v })} />
      </div>
      <span className="setting__hint">
        While a Focus task's timer runs, a full-screen reminder appears if you stay in an app or site
        that isn't part of the task. Applies to this Mac only.
      </span>

      {prefs.enabled && (
        <>
          <div className="setting__row">
            <span className="guard-settings__label">Grace period</span>
            <div className="segmented" role="group" aria-label="Grace period">
              {GRACE_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`segmented__opt${prefs.graceSecs === s ? " segmented__opt--active" : ""}`}
                  aria-pressed={prefs.graceSecs === s}
                  onClick={() => set({ graceSecs: s })}
                >
                  {s < 60 ? `${s}s` : `${s / 60}m`}
                </button>
              ))}
            </div>
          </div>

          <div className="setting__row">
            <span className="guard-settings__label">Block new tasks completely</span>
            <OnOff
              label="Block new tasks completely"
              value={prefs.blockCompletely}
              onChange={(v) => set({ blockCompletely: v })}
            />
          </div>

          <div className="setting__row">
            <span className="guard-settings__label">Whole-workday mode</span>
            <OnOff
              label="Whole-workday mode"
              value={prefs.workday.enabled}
              onChange={(v) => setWorkday({ enabled: v })}
            />
          </div>
          {prefs.workday.enabled && (
            <>
              <div className="guard-settings__workday">
                <label>
                  From
                  <input
                    className="account__input"
                    type="time"
                    value={prefs.workday.start}
                    onChange={(e) => e.target.value && setWorkday({ start: e.target.value })}
                  />
                </label>
                <label>
                  To
                  <input
                    className="account__input"
                    type="time"
                    value={prefs.workday.end}
                    onChange={(e) => e.target.value && setWorkday({ end: e.target.value })}
                  />
                </label>
                <label className="guard-settings__tz">
                  Time zone
                  <input
                    className="account__input"
                    type="text"
                    spellCheck={false}
                    value={prefs.workday.tz}
                    onChange={(e) => setWorkday({ tz: e.target.value })}
                    onBlur={(e) => !e.target.value.trim() && setWorkday({ tz: "Asia/Bangkok" })}
                  />
                </label>
              </div>
              <span className="setting__hint">
                Monday to Saturday. During these hours the guard is on even with the timer paused, and
                asks you to pick a task when none is running.
              </span>
            </>
          )}
        </>
      )}

      <NudgeLook prefs={prefs} onChange={onChange} previewTask={previewTask} />

      <TodoistKey />

      <button type="button" className="account__btn" onClick={onOpenStats}>
        Stats
      </button>
    </div>
  );
}
