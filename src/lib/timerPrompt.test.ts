import "./testDomShim";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getRemindStart,
  msUntilStartPrompt,
  nextIdleSince,
  shouldShowStartPrompt,
  START_PROMPT_DELAY_MS,
  storeRemindStart,
  type StartPromptInput,
} from "./timerPrompt";

const base = (over: Partial<StartPromptInput> = {}): StartPromptInput => ({
  enabled: true,
  cardKey: "read the rfc",
  timerStatus: "set timer",
  idleSince: { key: "read the rfc", since: 1000 },
  dismissedKey: null,
  now: 1000 + START_PROMPT_DELAY_MS,
  ...over,
});

describe("shouldShowStartPrompt", () => {
  it("shows after 20s of a set card with an idle timer", () => {
    expect(START_PROMPT_DELAY_MS).toBe(20_000);
    expect(shouldShowStartPrompt(base())).toBe(true);
    expect(shouldShowStartPrompt(base({ now: 1000 + 19_999 }))).toBe(false);
  });
  it("never shows without a card, for a done card (null key), or when turned off", () => {
    expect(shouldShowStartPrompt(base({ cardKey: null }))).toBe(false);
    expect(shouldShowStartPrompt(base({ enabled: false }))).toBe(false);
  });
  it("only for an idle timer: not running, paused or finished", () => {
    for (const s of ["focusing", "paused", "time's up"]) {
      expect(shouldShowStartPrompt(base({ timerStatus: s }))).toBe(false);
    }
  });
  it("'Not now' hides it for that card only", () => {
    expect(shouldShowStartPrompt(base({ dismissedKey: "read the rfc" }))).toBe(false);
    expect(shouldShowStartPrompt(base({ dismissedKey: "another card" }))).toBe(true);
  });
  it("the idle clock must belong to the current card", () => {
    expect(shouldShowStartPrompt(base({ idleSince: { key: "old card", since: 0 } }))).toBe(false);
    expect(shouldShowStartPrompt(base({ idleSince: null }))).toBe(false);
  });
  it("reports how long until it shows", () => {
    expect(msUntilStartPrompt(base({ now: 1000 }))).toBe(20_000);
    expect(msUntilStartPrompt(base({ now: 1000 + 25_000 }))).toBe(0);
    expect(msUntilStartPrompt(base({ timerStatus: "focusing" }))).toBeNull();
    expect(msUntilStartPrompt(base({ dismissedKey: "read the rfc" }))).toBeNull();
  });
});

describe("nextIdleSince", () => {
  it("starts the clock for a card with an idle timer and keeps it while nothing changes", () => {
    const a = nextIdleSince(null, "k", "set timer", 100);
    expect(a).toEqual({ key: "k", since: 100 });
    expect(nextIdleSince(a, "k", "set timer", 5000)).toBe(a);
  });
  it("restarts for a new card and clears once the timer leaves idle or the card goes", () => {
    const a = { key: "k", since: 100 };
    expect(nextIdleSince(a, "other", "set timer", 900)).toEqual({ key: "other", since: 900 });
    expect(nextIdleSince(a, "k", "focusing", 900)).toBeNull();
    expect(nextIdleSince(a, "k", "paused", 900)).toBeNull();
    expect(nextIdleSince(a, null, "set timer", 900)).toBeNull();
    // Reset back to idle afterwards: a fresh 20s.
    expect(nextIdleSince(null, "k", "set timer", 2000)).toEqual({ key: "k", since: 2000 });
  });
});

describe("Remind me to start the timer (device-local)", () => {
  beforeEach(() => localStorage.clear());
  it("defaults On and round-trips", () => {
    expect(getRemindStart()).toBe(true);
    storeRemindStart(false);
    expect(getRemindStart()).toBe(false);
    storeRemindStart(true);
    expect(getRemindStart()).toBe(true);
  });
});
