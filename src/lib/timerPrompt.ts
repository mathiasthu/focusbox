// "Start the timer for this task?": a quiet in-app reminder in the main window when a
// Focus card is set but its timer was never started. It replaces the old full-screen
// workday "No task running" nudge, which the owner found too pushy (2026-10-05): nothing
// pops up over other apps, there is no sound, and it only ever appears inside Focusbox.
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
  /** The card the user said "Not now" to, if any. */
  dismissedKey: string | null;
  now: number;
}

/** Whether to show the reminder now. */
export function shouldShowStartPrompt(i: StartPromptInput): boolean {
  if (!i.enabled || !i.cardKey) return false;
  if (i.timerStatus !== TIMER_IDLE_STATUS) return false;
  if (i.dismissedKey === i.cardKey) return false;
  if (!i.idleSince || i.idleSince.key !== i.cardKey) return false;
  return i.now - i.idleSince.since >= START_PROMPT_DELAY_MS;
}

/** Milliseconds until it would show (for a single timer), or null if it never will
 * without something else changing. */
export function msUntilStartPrompt(i: StartPromptInput): number | null {
  if (!i.enabled || !i.cardKey || i.timerStatus !== TIMER_IDLE_STATUS) return null;
  if (i.dismissedKey === i.cardKey || !i.idleSince || i.idleSince.key !== i.cardKey) return null;
  return Math.max(0, i.idleSince.since + START_PROMPT_DELAY_MS - i.now);
}

const KEY = "focusbox-remind-start-timer";

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
