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
  [["code", "focusbox", "build", "bug", "bugs", "deploy"], CODE],
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
  type Acc = { secs: number; drifts: number; by: Map<string, number>; switches: DayStats["switches"]; parked: DayStats["parked"] };
  const days = new Map<string, Acc>();
  const acc = (day: string): Acc => {
    let a = days.get(day);
    if (!a) {
      a = { secs: 0, drifts: 0, by: new Map(), switches: [], parked: [] };
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

export interface GuardPrefs {
  enabled: boolean;
  graceSecs: number;
  /** New-task prompt offers only "Park it". */
  blockCompletely: boolean;
  workday: { enabled: boolean; start: string; end: string; tz: string };
}

export const DEFAULT_GUARD_PREFS: GuardPrefs = {
  enabled: false,
  graceSecs: 30,
  blockCompletely: false,
  workday: { enabled: false, start: "10:00", end: "19:00", tz: "Asia/Bangkok" },
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
  };
}

export function getGuardPrefs(): GuardPrefs {
  if (isDemo()) return normalizePrefs(null);
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePrefs(null);
  }
}

export function storeGuardPrefs(p: GuardPrefs): void {
  if (isDemo()) return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage full / disabled: the setting just won't survive a restart */
  }
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
}

export function buildGuardConfig(
  prefs: GuardPrefs,
  task: { text: string; done: boolean } | null,
  timer: GuardTimer,
  overrides: AllowOverrides,
): GuardConfigPayload {
  const text = task && !task.done ? task.text : "";
  const allow = text ? effectiveAllow(text, overrides) : { apps: [], domains: [] };
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
