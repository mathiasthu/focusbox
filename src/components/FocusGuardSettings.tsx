// Settings → "Focus guard" (macOS desktop only; Settings renders this only when the Rust
// side reports the guard as supported). Device-local: stored in localStorage via
// focusGuard.ts, never in the settings sync blob.
import { useEffect, useState } from "react";
import {
  addAlwaysApp,
  addAlwaysDomain,
  appDisplayName,
  defaultAllow,
  formatClock,
  guardRunningApps,
  normalizeTaskKey,
  PAUSE_OPTIONS,
  removeAlwaysApp,
  removeAlwaysDomain,
  removeOverride,
  type AllowedApp,
  type AllowOverrides,
  type AlwaysAllow,
  getNudgeOpacity,
  GRACE_OPTIONS,
  IDLE_OPTIONS,
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
  extras: GuardExtras;
}

/** The always-allowed list, the per-task overrides and "Pause guard", owned by App.tsx. */
export interface GuardExtras {
  alwaysAllow: AlwaysAllow;
  onAlwaysAllowChange: (next: AlwaysAllow) => void;
  overrides: AllowOverrides;
  onOverridesChange: (next: AllowOverrides) => void;
  /** Epoch ms; 0 = not paused. */
  pausedUntil: number;
  onPause: (minutes: number) => void;
  onResume: () => void;
}

function Chip({ label, onRemove, muted, title }: { label: string; onRemove?: () => void; muted?: boolean; title?: string }) {
  return (
    <span className={`guard-chip${muted ? " guard-chip--muted" : ""}`} title={title}>
      {label}
      {onRemove && (
        <button type="button" className="guard-chip__x" aria-label={`Remove ${label}`} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}

/** "Always allowed": on task for every task. Sites typed in, apps picked from what's running. */
function AlwaysAllowed({ extras }: { extras: GuardExtras }) {
  const { alwaysAllow: a, onAlwaysAllowChange: set } = extras;
  const [site, setSite] = useState("");
  const [siteError, setSiteError] = useState<string | null>(null);
  const [running, setRunning] = useState<AllowedApp[] | null>(null);
  const [pick, setPick] = useState("");

  function addSite() {
    const r = addAlwaysDomain(a, site);
    if (r.error) {
      setSiteError(r.error);
      return;
    }
    setSiteError(null);
    setSite("");
    set(r.next);
  }

  async function openPicker() {
    const apps = (await guardRunningApps()).filter((x) => !a.apps.some((y) => y.bundleId === x.bundleId));
    setRunning(apps);
    setPick(apps[0]?.bundleId ?? "");
  }

  return (
    <div className="guard-settings__allow">
      <span className="guard-settings__label">Always allowed</span>
      <span className="setting__hint">
        Counts for every task. For apps that only fit some tasks, use Allow on the nudge instead.
      </span>
      <div className="guard-chips">
        {a.apps.map((x) => (
          <Chip key={x.bundleId} label={x.name} title={x.bundleId} onRemove={() => set(removeAlwaysApp(a, x.bundleId))} />
        ))}
        {a.domains.map((d) => (
          <Chip key={d} label={d} onRemove={() => set(removeAlwaysDomain(a, d))} />
        ))}
        {a.apps.length === 0 && a.domains.length === 0 && <span className="setting__hint">Nothing yet.</span>}
      </div>
      <div className="account__row guard-settings__keyrow">
        <input
          className="account__input"
          type="text"
          spellCheck={false}
          placeholder="Add site, e.g. github.com"
          value={site}
          onChange={(e) => {
            setSite(e.target.value);
            setSiteError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && site.trim()) addSite();
          }}
          aria-label="Add site"
        />
        <button type="button" className="account__btn" disabled={!site.trim()} onClick={addSite}>
          Add site
        </button>
      </div>
      {siteError && <span className="account__status account__status--error">{siteError}</span>}
      {running === null ? (
        <button type="button" className="account__btn" onClick={() => void openPicker()}>
          Add app
        </button>
      ) : running.length === 0 ? (
        <span className="setting__hint">No other running apps to add.</span>
      ) : (
        <div className="account__row guard-settings__keyrow">
          <select className="account__input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Running apps">
            {running.map((x) => (
              <option key={x.bundleId} value={x.bundleId}>
                {x.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="account__btn account__btn--primary"
            disabled={!pick}
            onClick={() => {
              const app = running.find((x) => x.bundleId === pick);
              if (app) set(addAlwaysApp(a, app));
              setRunning(null);
            }}
          >
            Add
          </button>
          <button type="button" className="account__btn" onClick={() => setRunning(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** What counts as on task for the current Focus task: name-derived (fixed) and added. */
function TaskAllowed({ task, extras }: { task: string; extras: GuardExtras }) {
  const key = normalizeTaskKey(task);
  const fromName = defaultAllow(task);
  const added = extras.overrides[key] ?? { apps: [], domains: [] };
  const known = extras.alwaysAllow.apps;
  const nothing = !fromName.apps.length && !fromName.domains.length && !added.apps.length && !added.domains.length;
  const remove = (r: { app?: string; domain?: string }) => extras.onOverridesChange(removeOverride(extras.overrides, key, r));
  return (
    <div className="guard-settings__allow">
      <span className="guard-settings__label">Allowed for "{task}"</span>
      <div className="guard-chips">
        {fromName.apps.map((b) => (
          <Chip key={`n-${b}`} label={appDisplayName(b, known)} muted title="From task name" />
        ))}
        {fromName.domains.map((d) => (
          <Chip key={`n-${d}`} label={d} muted title="From task name" />
        ))}
        {added.apps.map((b) => (
          <Chip key={`a-${b}`} label={appDisplayName(b, known)} title={b} onRemove={() => remove({ app: b })} />
        ))}
        {added.domains.map((d) => (
          <Chip key={`a-${d}`} label={d} onRemove={() => remove({ domain: d })} />
        ))}
        {nothing && <span className="setting__hint">Only the always-allowed list. Use "Allow" on a reminder to add more.</span>}
      </div>
      {(fromName.apps.length > 0 || fromName.domains.length > 0) && (
        <span className="setting__hint">Faded ones come from the task name.</span>
      )}
    </div>
  );
}

function PauseRow({ extras }: { extras: GuardExtras }) {
  // Re-render each minute isn't needed: App clears pausedUntil when it runs out.
  if (extras.pausedUntil > Date.now()) {
    return (
      <div className="setting__row">
        <span className="guard-settings__label">Paused until {formatClock(extras.pausedUntil)}</span>
        <button type="button" className="account__btn account__btn--primary" onClick={extras.onResume}>
          Resume now
        </button>
      </div>
    );
  }
  return (
    <div className="setting__row">
      <span className="guard-settings__label">Pause guard</span>
      <div className="segmented" role="group" aria-label="Pause guard">
        {PAUSE_OPTIONS.map((m) => (
          <button key={m} type="button" className="segmented__opt" onClick={() => extras.onPause(m)}>
            {m} min
          </button>
        ))}
      </div>
    </div>
  );
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

export default function FocusGuardSettings({ prefs, onChange, onOpenStats, previewTask, extras }: Props) {
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
          <PauseRow extras={extras} />

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
            <span className="guard-settings__label">Idle after</span>
            <div className="segmented" role="group" aria-label="Idle after">
              {IDLE_OPTIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`segmented__opt${prefs.idleMins === m ? " segmented__opt--active" : ""}`}
                  aria-pressed={prefs.idleMins === m}
                  onClick={() => set({ idleMins: m })}
                >
                  {m}m
                </button>
              ))}
            </div>
          </div>
          <span className="setting__hint">
            No input for this long pauses the guard. Videos in the app in front still count.
          </span>

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

      <AlwaysAllowed extras={extras} />
      {previewTask.trim() && <TaskAllowed task={previewTask} extras={extras} />}

      <NudgeLook prefs={prefs} onChange={onChange} previewTask={previewTask} />

      <TodoistKey />

      <button type="button" className="account__btn" onClick={onOpenStats}>
        Stats
      </button>
    </div>
  );
}
