// "Start the timer for this task?": a quiet in-app reminder in the main window when a
// Focus card is set but its timer was never started. It replaces the old full-screen
// workday "No task running" nudge, which the owner found too pushy (2026-10-05): nothing
// pops up over other apps, there is no sound, and it only ever appears inside Focusbox.
//
// It asks at most once a day: once it has been on screen and gone again ("Start timer",
// "Not now", or the timer started some other way), it stays away until the next local
// day (owner, 2026-10-06). It also stays away during a Zoom or Google Meet call.
//
// Device-local preference (localStorage, default On), like the other per-machine
// settings; deliberately not in SettingsValue / sync.
import { isDemo } from "./demo";

/** Wait this long after the card is set (and the timer still idle) before asking, so it
 * doesn't nag while the session is being set up. */
export const START_PROMPT_DELAY_MS = 20_000;

/** Timer.tsx's status for "never started for this card / reset". */
export const TIMER_IDLE_STATUS = "set timer";

/** When the current card's idle stretch began. Keyed by card so a new card starts over. */
export interface IdleSince {
  key: string;
  since: number;
}

/**
 * Track when the card `key` started waiting on an idle timer. A new card, or the timer
 * leaving idle (started; a paused or finished timer is not idle), restarts or clears it.
 */
export function nextIdleSince(prev: IdleSince | null, key: string | null, timerStatus: string, now: number): IdleSince | null {
  if (!key || timerStatus !== TIMER_IDLE_STATUS) return null;
  if (prev && prev.key === key) return prev;
  return { key, since: now };
}

export interface StartPromptInput {
  enabled: boolean;
  /** The Focus card's key, or null when there is no card or it is done. */
  cardKey: string | null;
  timerStatus: string;
  idleSince: IdleSince | null;
  /** The local day (localDay) the reminder was last shown and closed, if any. */
  usedDay: string | null;
  /** In a Zoom / Google Meet call right now. */
  inMeeting: boolean;
  now: number;
}

/** The local calendar day of `ms` as YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Milliseconds from `ms` to the next local midnight. */
export function msUntilNextDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - ms;
}

/** Whether to show the reminder now. */
export function shouldShowStartPrompt(i: StartPromptInput): boolean {
  if (!i.enabled || !i.cardKey) return false;
  if (i.timerStatus !== TIMER_IDLE_STATUS) return false;
  if (i.inMeeting || i.usedDay === localDay(i.now)) return false;
  if (!i.idleSince || i.idleSince.key !== i.cardKey) return false;
  return i.now - i.idleSince.since >= START_PROMPT_DELAY_MS;
}

/** Milliseconds until it would show (for a single timer), or null if it never will
 * without something else changing. Already used today: wait for the next day. A call
 * isn't timed here; the caller re-checks it. */
export function msUntilStartPrompt(i: StartPromptInput): number | null {
  if (!i.enabled || !i.cardKey || i.timerStatus !== TIMER_IDLE_STATUS) return null;
  if (!i.idleSince || i.idleSince.key !== i.cardKey) return null;
  const due = Math.max(0, i.idleSince.since + START_PROMPT_DELAY_MS - i.now);
  if (i.usedDay === localDay(i.now)) return Math.max(due, msUntilNextDay(i.now));
  return due;
}

const KEY = "focusbox-remind-start-timer";
const USED_DAY_KEY = "focusbox-start-prompt-day";

/** The day the reminder was used up (see the header). Survives a restart. */
export function getPromptUsedDay(): string | null {
  if (isDemo()) return null;
  try {
    return localStorage.getItem(USED_DAY_KEY);
  } catch {
    return null;
  }
}

export function storePromptUsedDay(day: string): void {
  if (isDemo()) return;
  try {
    localStorage.setItem(USED_DAY_KEY, day);
  } catch {
    /* not persisted: it may ask once more after a restart */
  }
}

/** "Remind me to start the timer": default On. */
export function getRemindStart(): boolean {
  if (isDemo()) return true;
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function storeRemindStart(on: boolean): void {
  if (isDemo()) return;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* not persisted */
  }
}
