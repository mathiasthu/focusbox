// Focus guard, frontend half. The watching itself happens in Rust
// (src-tauri/src/focusguard.rs) because this webview's timers are throttled while the
// window is hidden, which is exactly when the guard has to work. This module holds:
//
// - pure helpers (unit-tested): task-key normalization, the keyword → allow-list
//   defaults, reason validation, timer-status mapping, and the stats aggregation;
// - the device-local preferences (localStorage, like chime.ts / trayVisibility.ts —
//   deliberately NOT in SettingsValue: the guard watches THIS machine, and syncing it
//   would switch it on somewhere it can't work or wasn't wanted);
// - thin invoke wrappers that degrade to no-ops off-Tauri, like autostart.ts / tray.ts.
//
// Todoist is reached only through Rust commands. The webview never calls it (the CSP and
// `npm run check:csp` both forbid it) and never sees the API key.

import { invoke } from "@tauri-apps/api/core";
import { isDemo } from "./demo";
import { isTauri, storeGet, storeSet } from "./store";

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

export const MIN_REASON_CHARS = 10;

/** A typed reason long enough to count: at least 10 characters once trimmed. */
export function isValidReason(reason: string | null | undefined): boolean {
  return [...(reason ?? "").trim()].length >= MIN_REASON_CHARS;
}

/** The key per-task allow-lists are stored under: lowercased, trimmed, spaces collapsed. */
export function normalizeTaskKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface AllowList {
  apps: string[];
  domains: string[];
}

const CODE: AllowList = {
  apps: [
    "com.microsoft.VSCode",
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "com.anthropic.claudefordesktop",
  ],
  domains: ["github.com", "claude.ai"],
};

// Keyword (a whole word of the task text, case-insensitive) → what that task needs.
const KEYWORDS: [string[], AllowList][] = [
  [["dm", "dms", "leads", "lead", "outreach", "instagram"], { apps: [], domains: ["instagram.com"] }],
  [["linkedin"], { apps: [], domains: ["linkedin.com"] }],
  [["whmcs", "luxvps", "billing", "ticket", "tickets"], { apps: [], domains: ["luxvps.net", "billing.luxvps.net"] }],
  // Dev work: the coding tools come from the task's wording, never from a global list,
  // so "Read and meditate" doesn't quietly allow Claude.
  [
    [
      "code", "coding", "dev", "build", "bug", "bugs", "fix", "feature", "deploy", "ship",
      "release", "repo", "github", "focusbox", "claude", "app", "tauri", "website",
    ],
    CODE,
  ],
  [["email", "emails", "gmail", "inbox"], { apps: [], domains: ["mail.google.com"] }],
  [["momentum", "website"], { apps: [], domains: ["momentumminds.net"] }],
  [["notion"], { apps: ["notion.id"], domains: ["notion.so"] }],
  [["todoist"], { apps: ["com.todoist.mac.Todoist"], domains: ["todoist.com"] }],
];

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function union(...lists: AllowList[]): AllowList {
  const apps = new Set<string>();
  const domains = new Set<string>();
  for (const l of lists) {
    l.apps.forEach((a) => apps.add(a));
    l.domains.forEach((d) => domains.add(d));
  }
  return { apps: [...apps], domains: [...domains] };
}

/** The allow-list guessed from a task's wording. */
export function defaultAllow(taskText: string): AllowList {
  const w = words(taskText);
  return union(...KEYWORDS.filter(([keys]) => keys.some((k) => w.has(k))).map(([, l]) => l));
}

/** Per-task additions, keyed by normalizeTaskKey(text). Stored under "focusGuardAllow". */
export type AllowOverrides = Record<string, AllowList>;

export function effectiveAllow(taskText: string, overrides: AllowOverrides): AllowList {
  const extra = overrides[normalizeTaskKey(taskText)];
  return extra ? union(defaultAllow(taskText), extra) : defaultAllow(taskText);
}

/** Add one app and/or domain to a task's overrides. Returns the same object when nothing
 * changed, so callers can skip the write. */
export function addOverride(
  overrides: AllowOverrides,
  taskKey: string,
  add: { app?: string | null; domain?: string | null },
): AllowOverrides {
  const cur = overrides[taskKey] ?? { apps: [], domains: [] };
  const apps = add.app && !cur.apps.includes(add.app) ? [...cur.apps, add.app] : cur.apps;
  const domains =
    add.domain && !cur.domains.includes(add.domain) ? [...cur.domains, add.domain] : cur.domains;
  if (apps === cur.apps && domains === cur.domains) return overrides;
  return { ...overrides, [taskKey]: { apps, domains } };
}

/** Take one app and/or domain out of a task's overrides. The task's entry goes once it is
 * empty. Same object back when nothing changed. */
export function removeOverride(
  overrides: AllowOverrides,
  taskKey: string,
  remove: { app?: string; domain?: string },
): AllowOverrides {
  const cur = overrides[taskKey];
  if (!cur) return overrides;
  const apps = remove.app ? cur.apps.filter((a) => a !== remove.app) : cur.apps;
  const domains = remove.domain ? cur.domains.filter((d) => d !== remove.domain) : cur.domains;
  if (apps.length === cur.apps.length && domains.length === cur.domains.length) return overrides;
  const next = { ...overrides };
  if (apps.length === 0 && domains.length === 0) delete next[taskKey];
  else next[taskKey] = { apps, domains };
  return next;
}

/** Readable names for bundle ids the app knows about (chips in Settings). */
const APP_NAMES: Record<string, string> = {
  "com.microsoft.VSCode": "VS Code",
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm",
  "com.anthropic.claudefordesktop": "Claude",
  "notion.id": "Notion",
  "com.todoist.mac.Todoist": "Todoist",
  "com.google.Chrome": "Google Chrome",
  "com.apple.Safari": "Safari",
  "company.thebrowser.Browser": "Arc",
};

export function appDisplayName(bundleId: string, known: { bundleId: string; name: string }[] = []): string {
  return known.find((a) => a.bundleId === bundleId)?.name ?? APP_NAMES[bundleId] ?? bundleId;
}

/** A user-typed site → a bare hostname to match as a suffix ("github.com" also covers
 * "gist.github.com"). Scheme, userinfo, port, path, query, "*." and "www." are stripped
 * first (same rules as the Rust side); what's left must be a plain dotted hostname, or
 * this returns null. */
export function normalizeHostname(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  const scheme = s.indexOf("://");
  if (scheme >= 0) s = s.slice(scheme + 3);
  const cut = s.search(/[/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(0, colon);
  s = s.replace(/^\*\./, "").replace(/^www\./, "").replace(/^\.+|\.+$/g, "");
  if (s.length > 253) return null;
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s) && /\.[a-z]{2,}$|\.xn--[a-z0-9-]+$/.test(s)
    ? s
    : null;
}

// ---------------------------------------------------------------------------------------
// "Always allowed": apps and sites that are on task for every task (device-local)
// ---------------------------------------------------------------------------------------

export interface AllowedApp {
  bundleId: string;
  name: string;
}

export interface AlwaysAllow {
  apps: AllowedApp[];
  domains: string[];
}

/** Starts empty: anything here is on task for EVERY task, so it's the user's to fill. */
export const DEFAULT_ALWAYS_ALLOW: AlwaysAllow = { apps: [], domains: [] };

/** What 0.2.26 and 0.2.27 seeded into everyone's list. Version 2 of the stored list takes
 * exactly these out once (they made Claude "on task" for "Read and meditate"); anything
 * the user added is kept, and re-adding one afterwards sticks. */
export const OLD_ALWAYS_SEED = {
  apps: ["com.anthropic.claudefordesktop", "com.apple.Terminal", "com.googlecode.iterm2", "com.microsoft.VSCode"],
  domains: ["claude.ai"],
};
const ALWAYS_VERSION = 2;

const ALWAYS_KEY = "focusbox-guard-always-allow";

export function parseAlwaysAllow(raw: unknown): AlwaysAllow {
  const out: AlwaysAllow = { apps: [], domains: [] };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { apps?: unknown; domains?: unknown };
  if (Array.isArray(r.apps)) {
    for (const a of r.apps) {
      if (!a || typeof a !== "object") continue;
      const { bundleId, name } = a as { bundleId?: unknown; name?: unknown };
      if (typeof bundleId !== "string" || !bundleId.trim()) continue;
      if (out.apps.some((x) => x.bundleId === bundleId)) continue;
      out.apps.push({ bundleId, name: typeof name === "string" && name.trim() ? name : appDisplayName(bundleId) });
    }
  }
  if (Array.isArray(r.domains)) {
    for (const d of r.domains) {
      const h = typeof d === "string" ? normalizeHostname(d) : null;
      if (h && !out.domains.includes(h)) out.domains.push(h);
    }
  }
  return out;
}

/** Remove the old seed entries (see OLD_ALWAYS_SEED), keeping everything else. */
export function withoutOldSeed(a: AlwaysAllow): AlwaysAllow {
  return {
    apps: a.apps.filter((x) => !OLD_ALWAYS_SEED.apps.includes(x.bundleId)),
    domains: a.domains.filter((d) => !OLD_ALWAYS_SEED.domains.includes(d)),
  };
}

export function getAlwaysAllow(): AlwaysAllow {
  const empty = () => ({ apps: [...DEFAULT_ALWAYS_ALLOW.apps], domains: [...DEFAULT_ALWAYS_ALLOW.domains] });
  if (isDemo()) return empty();
  try {
    const raw = localStorage.getItem(ALWAYS_KEY);
    if (raw === null) return empty();
    const parsed = JSON.parse(raw);
    const list = parseAlwaysAllow(parsed);
    if ((parsed as { v?: unknown } | null)?.v !== ALWAYS_VERSION) {
      const migrated = withoutOldSeed(list);
      storeAlwaysAllow(migrated);
      return migrated;
    }
    return list;
  } catch {
    return empty();
  }
}

export function storeAlwaysAllow(a: AlwaysAllow): void {
  if (isDemo()) return;
  try {
    localStorage.setItem(ALWAYS_KEY, JSON.stringify({ apps: a.apps, domains: a.domains, v: ALWAYS_VERSION }));
  } catch {
    /* not persisted */
  }
}

export function addAlwaysApp(a: AlwaysAllow, app: AllowedApp): AlwaysAllow {
  if (!app.bundleId || a.apps.some((x) => x.bundleId === app.bundleId)) return a;
  return { ...a, apps: [...a.apps, app] };
}

export function removeAlwaysApp(a: AlwaysAllow, bundleId: string): AlwaysAllow {
  return { ...a, apps: a.apps.filter((x) => x.bundleId !== bundleId) };
}

/** Add a typed site. `error` says why nothing was added. */
export function addAlwaysDomain(a: AlwaysAllow, raw: string): { next: AlwaysAllow; error?: string } {
  const h = normalizeHostname(raw);
  if (!h) return { next: a, error: "That doesn't look like a site name (e.g. github.com)." };
  if (a.domains.includes(h)) return { next: a, error: `${h} is already allowed.` };
  return { next: { ...a, domains: [...a.domains, h] } };
}

export function removeAlwaysDomain(a: AlwaysAllow, domain: string): AlwaysAllow {
  return { ...a, domains: a.domains.filter((d) => d !== domain) };
}

/** Everything that is on task for `taskText`: keyword defaults, that task's overrides and
 * the always-allowed list, without duplicates. Empty when there is no task. */
export function mergedAllow(taskText: string, overrides: AllowOverrides, always: AlwaysAllow): AllowList {
  if (!taskText.trim()) return { apps: [], domains: [] };
  return union(effectiveAllow(taskText, overrides), {
    apps: always.apps.map((x) => x.bundleId),
    domains: always.domains,
  });
}

// ---------------------------------------------------------------------------------------
// "Pause guard" (device-local; Rust treats now < pausedUntil as idle)
// ---------------------------------------------------------------------------------------

export const PAUSE_OPTIONS = [15, 30, 60] as const;
const PAUSE_KEY = "focusbox-guard-paused-until";
const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;

/** When a pause of `minutes` (clamped to 1–240) started at `now` ends. */
export function pauseUntil(now: number, minutes: number): number {
  const m = Number.isFinite(minutes) ? Math.min(240, Math.max(1, Math.round(minutes))) : 15;
  return now + m * 60_000;
}

/** A stored pause end, or 0 if there is none, it has passed, or it is implausibly far out. */
export function normalizePausedUntil(raw: unknown, now: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= now || n > now + MAX_PAUSE_MS) return 0;
  return Math.floor(n);
}

export function getPausedUntil(now = Date.now()): number {
  try {
    return normalizePausedUntil(localStorage.getItem(PAUSE_KEY), now);
  } catch {
    return 0;
  }
}

export function storePausedUntil(until: number): void {
  if (isDemo()) return;
  try {
    if (until > 0) localStorage.setItem(PAUSE_KEY, String(until));
    else localStorage.removeItem(PAUSE_KEY);
  } catch {
    /* not persisted */
  }
}

/** "HH:MM" in local time. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Lenient read of the stored overrides: anything malformed is dropped, not trusted. */
export function parseOverrides(raw: unknown): AllowOverrides {
  const out: AllowOverrides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const { apps, domains } = v as { apps?: unknown; domains?: unknown };
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
    out[k] = { apps: strs(apps), domains: strs(domains) };
  }
  return out;
}

export type GuardTimer = "running" | "paused" | "idle";

/** Timer.tsx's status string → what the guard needs to know. */
export function timerStateFromStatus(status: string): GuardTimer {
  if (status === "focusing") return "running";
  if (status === "paused") return "paused";
  return "idle";
}

// ---------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------

export interface GuardLogEntry {
  ts: number;
  kind: string;
  task: string;
  app?: string;
  domain?: string;
  reason?: string;
  /** What was parked (kind "park"); older entries kept it in `reason`. */
  text?: string;
  secs?: number;
}

export interface DayStats {
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  focusedMinutes: number;
  /** Idle or locked while the guard was active. */
  awayMinutes: number;
  drifts: number;
  /** Top 5 off-task sites/apps by drift count. */
  topDrift: { label: string; count: number }[];
  switches: { task: string; reason: string; ts: number }[];
  parked: { text: string; ts: number }[];
}

export function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Bucket raw log entries by local day, newest day first. Today is always present. */
export function aggregateStats(entries: GuardLogEntry[], now: number): DayStats[] {
  type Acc = { secs: number; away: number; drifts: number; by: Map<string, number>; switches: DayStats["switches"]; parked: DayStats["parked"] };
  const days = new Map<string, Acc>();
  const acc = (day: string): Acc => {
    let a = days.get(day);
    if (!a) {
      a = { secs: 0, away: 0, drifts: 0, by: new Map(), switches: [], parked: [] };
      days.set(day, a);
    }
    return a;
  };
  acc(localDay(now));
  for (const e of [...entries].sort((x, y) => x.ts - y.ts)) {
    const a = acc(localDay(e.ts));
    switch (e.kind) {
      case "focused_secs":
        a.secs += Math.max(0, e.secs ?? 0);
        break;
      case "away_secs":
        a.away += Math.max(0, e.secs ?? 0);
        break;
      case "drift": {
        a.drifts += 1;
        const label = e.domain || e.app || "Unknown";
        a.by.set(label, (a.by.get(label) ?? 0) + 1);
        break;
      }
      case "switch":
      case "newtask_switch":
        if (e.reason) a.switches.push({ task: e.task, reason: e.reason, ts: e.ts });
        break;
      case "park":
        a.parked.push({ text: e.text || e.reason || e.domain || e.app || "", ts: e.ts });
        break;
      case "newtask_park":
        a.parked.push({ text: e.task, ts: e.ts });
        break;
    }
  }
  return [...days.entries()]
    .sort(([x], [y]) => (x < y ? 1 : x > y ? -1 : 0))
    .map(([day, a]) => ({
      day,
      focusedMinutes: Math.round(a.secs / 60),
      awayMinutes: Math.round(a.away / 60),
      drifts: a.drifts,
      topDrift: [...a.by.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, 5)
        .map(([label, count]) => ({ label, count })),
      switches: a.switches,
      parked: a.parked,
    }));
}

// ---------------------------------------------------------------------------------------
// Device-local preferences
// ---------------------------------------------------------------------------------------

export const GRACE_OPTIONS = [15, 30, 60, 120] as const;
/** "Idle after" choices, minutes. No hardware input this long = away (guard pauses). */
export const IDLE_OPTIONS = [1, 2, 3, 5, 10] as const;

export interface GuardPrefs {
  enabled: boolean;
  graceSecs: number;
  /** New-task prompt offers only "Park it". */
  blockCompletely: boolean;
  workday: { enabled: boolean; start: string; end: string; tz: string };
  /** Native blur behind the translucent nudge (macOS). */
  blur: boolean;
  /** Minutes without hardware input before the guard counts the user as away. */
  idleMins: number;
}

export const DEFAULT_GUARD_PREFS: GuardPrefs = {
  enabled: false,
  graceSecs: 30,
  blockCompletely: false,
  workday: { enabled: false, start: "10:00", end: "19:00", tz: "Asia/Bangkok" },
  // Off by default since 0.2.26: the native material made the nudge read as nearly
  // opaque. See PREFS_VERSION for the one-time switch-off of the old default.
  blur: false,
  idleMins: 3,
};

/** Mon–Sat. Fixed for now; the Rust side takes a list so this can become a setting. */
export const WORKDAYS = [1, 2, 3, 4, 5, 6];

const PREFS_KEY = "focusbox-focus-guard";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizePrefs(raw: unknown): GuardPrefs {
  const d = DEFAULT_GUARD_PREFS;
  if (!raw || typeof raw !== "object") return { ...d, workday: { ...d.workday } };
  const r = raw as Omit<Partial<GuardPrefs>, "workday"> & { workday?: Partial<GuardPrefs["workday"]> };
  const w: Partial<GuardPrefs["workday"]> = r.workday ?? {};
  return {
    enabled: r.enabled === true,
    graceSecs: (GRACE_OPTIONS as readonly number[]).includes(r.graceSecs as number) ? (r.graceSecs as number) : d.graceSecs,
    blockCompletely: r.blockCompletely === true,
    workday: {
      enabled: w.enabled === true,
      start: typeof w.start === "string" && HHMM.test(w.start) ? w.start : d.workday.start,
      end: typeof w.end === "string" && HHMM.test(w.end) ? w.end : d.workday.end,
      tz: typeof w.tz === "string" && w.tz.trim() ? w.tz.trim() : d.workday.tz,
    },
    blur: r.blur === true,
    idleMins: (IDLE_OPTIONS as readonly number[]).includes(r.idleMins as number) ? (r.idleMins as number) : d.idleMins,
  };
}

/** Stored alongside the prefs. Version 2 = "blur default is Off" applied: settings saved
 * before it (no version) had blur On only because that was the old default, so they get
 * it switched Off once; anything chosen after that is respected. */
const PREFS_VERSION = 2;

export function getGuardPrefs(): GuardPrefs {
  if (isDemo()) return normalizePrefs(null);
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v !== PREFS_VERSION) {
      const migrated = normalizePrefs({ ...parsed, blur: false });
      storeGuardPrefs(migrated);
      return migrated;
    }
    return normalizePrefs(parsed);
  } catch {
    return normalizePrefs(null);
  }
}

export function storeGuardPrefs(p: GuardPrefs): void {
  if (isDemo()) return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...p, v: PREFS_VERSION }));
  } catch {
    /* storage full / disabled: the setting just won't survive a restart */
  }
}

// ---------------------------------------------------------------------------------------
// Nudge opacity (device-local, its own key so the nudge window can react to just it)
// ---------------------------------------------------------------------------------------

export const NUDGE_OPACITY_KEY = "focusbox-guard-nudge-opacity";
export const NUDGE_OPACITY_DEFAULT = 45;
export const NUDGE_OPACITY_MIN = 5;
export const NUDGE_OPACITY_MAX = 95;
export const NUDGE_OPACITY_STEP = 5;
/** The text card never drops below this, so the words never sit on bare desktop. 0.92
 * keeps --ink-soft at WCAG AA (≈4.6:1) on the light card even with black right behind it
 * and no blur. */
export const NUDGE_CARD_FLOOR = 0.92;

/** Percent, clamped to 5–95 and snapped to steps of 5. Anything unparseable → 45. */
export function normalizeNudgeOpacity(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return NUDGE_OPACITY_DEFAULT;
  const clamped = Math.min(NUDGE_OPACITY_MAX, Math.max(NUDGE_OPACITY_MIN, n));
  return Math.round(clamped / NUDGE_OPACITY_STEP) * NUDGE_OPACITY_STEP;
}

export function getNudgeOpacity(): number {
  try {
    return normalizeNudgeOpacity(localStorage.getItem(NUDGE_OPACITY_KEY));
  } catch {
    return NUDGE_OPACITY_DEFAULT;
  }
}

export function storeNudgeOpacity(percent: number): void {
  if (isDemo()) return;
  try {
    localStorage.setItem(NUDGE_OPACITY_KEY, String(normalizeNudgeOpacity(percent)));
  } catch {
    /* not persisted; the slider still works for this session */
  }
}

/** Alphas (0–1) for the nudge: the full-window tint, a slightly heavier dark-mode tint
 * (so dark stays darker than light at the same setting), and the text card, which never
 * goes below NUDGE_CARD_FLOOR. */
export function nudgeAlphas(percent: number): { tint: number; tintDark: number; card: number } {
  const tint = normalizeNudgeOpacity(percent) / 100;
  const r = (x: number) => Math.round(Math.min(1, x) * 100) / 100;
  return { tint: r(tint), tintDark: r(tint + 0.15), card: r(Math.max(tint + 0.25, NUDGE_CARD_FLOOR)) };
}

/** Set the CSS custom properties the nudge styles read (styles.css, .nudge). */
export function applyNudgeOpacity(el: HTMLElement, percent: number): void {
  const a = nudgeAlphas(percent);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  el.style.setProperty("--nudge-tint", pct(a.tint));
  el.style.setProperty("--nudge-tint-dark", pct(a.tintDark));
  el.style.setProperty("--nudge-card", pct(a.card));
}

// ---------------------------------------------------------------------------------------
// Rust bridge (no-ops off-Tauri)
// ---------------------------------------------------------------------------------------

const ALLOW_KEY = "focusGuardAllow";
const available = () => isTauri && !isDemo();

/** True only on macOS desktop, where Rust can actually see other apps. */
export async function isGuardSupported(): Promise<boolean> {
  if (!available()) return false;
  try {
    return await invoke<boolean>("guard_supported");
  } catch {
    return false;
  }
}

export interface GuardConfigPayload {
  enabled: boolean;
  hasTask: boolean;
  taskText: string;
  taskKey: string;
  timer: GuardTimer;
  allowApps: string[];
  allowDomains: string[];
  graceSecs: number;
  workday: { enabled: boolean; start: string; end: string; days: number[]; tz: string };
  blur: boolean;
  idleAfterSecs: number;
  pausedUntil: number;
}

export function buildGuardConfig(
  prefs: GuardPrefs,
  task: { text: string; done: boolean } | null,
  timer: GuardTimer,
  overrides: AllowOverrides,
  always: AlwaysAllow = { apps: [], domains: [] },
  pausedUntil = 0,
): GuardConfigPayload {
  const text = task && !task.done ? task.text : "";
  const allow = mergedAllow(text, overrides, always);
  return {
    enabled: prefs.enabled,
    hasTask: !!task && !task.done && text.trim().length > 0,
    taskText: text,
    taskKey: normalizeTaskKey(text),
    timer,
    allowApps: allow.apps,
    allowDomains: allow.domains,
    graceSecs: prefs.graceSecs,
    workday: { ...prefs.workday, days: WORKDAYS },
    blur: prefs.blur,
    idleAfterSecs: prefs.idleMins * 60,
    pausedUntil: Math.max(0, Math.floor(pausedUntil)),
  };
}

export async function pushGuardConfig(config: GuardConfigPayload): Promise<void> {
  if (!available()) return;
  try {
    await invoke("guard_set_config", { config });
  } catch (err) {
    console.error("Focusbox: focus guard config push failed", err);
  }
}

export async function guardRunningApps(): Promise<AllowedApp[]> {
  if (!available()) return [];
  try {
    return await invoke<AllowedApp[]>("guard_running_apps");
  } catch {
    return [];
  }
}

/** In a Zoom or Google Meet call right now (false when unknown or unsupported). */
export async function guardInMeeting(): Promise<boolean> {
  if (!available()) return false;
  try {
    return await invoke<boolean>("guard_in_meeting");
  } catch {
    return false;
  }
}

/** Settings → "Preview nudge". "ok", or "real_nudge_open" (a real nudge is up and wins). */
export async function previewNudge(taskText: string, blur: boolean): Promise<string> {
  if (!available()) return "unavailable";
  return invoke<string>("guard_preview_nudge", { taskText, blur });
}

export async function loadAllowOverrides(): Promise<AllowOverrides> {
  if (!available()) return {};
  try {
    return parseOverrides(await storeGet(ALLOW_KEY));
  } catch {
    return {};
  }
}

export async function saveAllowOverrides(o: AllowOverrides): Promise<void> {
  if (!available()) return;
  try {
    await storeSet({ [ALLOW_KEY]: o });
  } catch (err) {
    console.error("Focusbox: could not save the focus guard allow-list", err);
  }
}

export async function guardStats(days: number): Promise<GuardLogEntry[]> {
  if (!available()) return [];
  try {
    return await invoke<GuardLogEntry[]>("guard_stats", { days });
  } catch {
    return [];
  }
}

export async function logNewTask(
  kind: "newtask_park" | "newtask_switch",
  task: string,
  reason?: string,
): Promise<void> {
  if (!available()) return;
  try {
    await invoke("guard_log_newtask", { kind, task, reason: reason ?? null });
  } catch (err) {
    console.error("Focusbox: focus guard log failed", err);
  }
}

export interface TodoistStatus {
  configured: boolean;
  queued: number;
  authBlocked: boolean;
}

export async function todoistStatus(): Promise<TodoistStatus | null> {
  if (!available()) return null;
  try {
    return await invoke<TodoistStatus>("todoist_status");
  } catch {
    return null;
  }
}

/** "ok" | "invalid" | "offline" (saved, unverified). */
export async function todoistSetToken(token: string): Promise<string> {
  return invoke<string>("todoist_set_token", { token });
}

export async function todoistClearToken(): Promise<void> {
  await invoke("todoist_clear_token");
}

/** "sent" | "queued" | "rejected" | "no_token" | "auth_blocked". Throws if it couldn't
 * even be queued. Only the new item is sent; any older backlog is left to Rust's retry loop. */
export async function parkTask(text: string): Promise<string> {
  return invoke<string>("park", { text });
}

/** What the top-of-screen park confirmation says for a park result. */
export function toastCopy(result: string): { title: string; ok: boolean } {
  switch (result) {
    case "sent":
      return { title: "Parked in Todoist", ok: true };
    case "queued":
      return { title: "Saved, goes to Todoist when you're online", ok: false };
    case "no_token":
      return { title: "Saved. Add your Todoist key in Settings", ok: false };
    case "auth_blocked":
      return { title: "Todoist key rejected. Saved until fixed", ok: false };
    case "rejected":
      return { title: "Todoist refused it", ok: false };
    default:
      return { title: "Parked", ok: false };
  }
}

/** One line of the parked text for the toast: whitespace collapsed, at most `max`
 * characters (not UTF-16 units), with an ellipsis when cut. */
export function truncateForToast(text: string, max = 40): string {
  const clean = text.trim().replace(/\s+/g, " ");
  const chars = [...clean];
  if (chars.length <= max) return clean;
  return chars.slice(0, max - 1).join("").trimEnd() + "…";
}

export function parkResultMessage(result: string): string {
  switch (result) {
    case "sent":
      return "Parked in Todoist.";
    case "queued":
      return "Saved. It goes to Todoist when you're back online.";
    case "no_token":
      return "Saved. Add your Todoist key in Settings to send it.";
    case "rejected":
      return "Todoist refused it.";
    case "auth_blocked":
      return "Todoist key rejected, check Settings. Saved until then.";
    default:
      return "";
  }
}
