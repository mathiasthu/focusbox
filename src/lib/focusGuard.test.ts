import "./testDomShim";
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyNudgeOpacity,
  getNudgeOpacity,
  nudgeAlphas,
  normalizeNudgeOpacity,
  storeNudgeOpacity,
  NUDGE_OPACITY_KEY,
  parkResultMessage,
  addOverride,
  aggregateStats,
  buildGuardConfig,
  defaultAllow,
  DEFAULT_GUARD_PREFS,
  effectiveAllow,
  getGuardPrefs,
  isGuardSupported,
  isValidReason,
  localDay,
  normalizePrefs,
  normalizeTaskKey,
  parseOverrides,
  storeGuardPrefs,
  timerStateFromStatus,
  type GuardLogEntry,
} from "./focusGuard";

describe("normalizeTaskKey", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normalizeTaskKey("  Fix   the\tBUILD \n")).toBe("fix the build");
  });
  it("is stable for already-normalized text", () => {
    expect(normalizeTaskKey("write dms")).toBe("write dms");
  });
});

describe("defaultAllow (keyword map)", () => {
  it("maps outreach words to instagram", () => {
    expect(defaultAllow("Send 20 DMs").domains).toEqual(["instagram.com"]);
    expect(defaultAllow("leads batch").domains).toContain("instagram.com");
    expect(defaultAllow("Instagram outreach").domains).toEqual(["instagram.com"]);
  });
  it("matches whole words only, case-insensitively", () => {
    expect(defaultAllow("admin cleanup").domains).toEqual([]); // "dm" inside "admin"
    expect(defaultAllow("Codex review").apps).toEqual([]); // "code" inside "codex"
    expect(defaultAllow("CODE review").apps).toContain("com.microsoft.VSCode");
  });
  it("gives coding tasks the editor, terminals, Claude, GitHub and claude.ai", () => {
    const a = defaultAllow("focusbox: fix bug");
    expect(a.apps).toEqual([
      "com.microsoft.VSCode",
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "com.anthropic.claudefordesktop",
    ]);
    expect(a.domains).toEqual(["github.com", "claude.ai"]);
  });
  it("covers luxvps, linkedin, email, website, notion, todoist", () => {
    expect(defaultAllow("WHMCS ticket").domains).toEqual(["luxvps.net", "billing.luxvps.net"]);
    expect(defaultAllow("LinkedIn connections").domains).toEqual(["linkedin.com"]);
    expect(defaultAllow("clear inbox").domains).toEqual(["mail.google.com"]);
    expect(defaultAllow("Momentum website copy").domains).toEqual(["momentumminds.net"]);
    expect(defaultAllow("notion page")).toEqual({ apps: ["notion.id"], domains: ["notion.so"] });
    expect(defaultAllow("todoist cleanup")).toEqual({
      apps: ["com.todoist.mac.Todoist"],
      domains: ["todoist.com"],
    });
  });
  it("unions several keyword groups without duplicates", () => {
    const a = defaultAllow("deploy luxvps website build");
    expect(a.domains).toEqual(["luxvps.net", "billing.luxvps.net", "github.com", "claude.ai", "momentumminds.net"]);
    expect(new Set(a.apps).size).toBe(a.apps.length);
  });
  it("is empty for an unknown task", () => {
    expect(defaultAllow("think about pricing")).toEqual({ apps: [], domains: [] });
  });
});

describe("per-task overrides", () => {
  it("adds to the right normalized key and merges with the defaults", () => {
    let o = addOverride({}, normalizeTaskKey("Send DMs"), { domain: "facebook.com" });
    o = addOverride(o, normalizeTaskKey("Send DMs"), { app: "com.apple.Notes" });
    const eff = effectiveAllow("  send   dms ", o);
    expect(eff.domains).toEqual(["instagram.com", "facebook.com"]);
    expect(eff.apps).toEqual(["com.apple.Notes"]);
    expect(effectiveAllow("other task", o)).toEqual({ apps: [], domains: [] });
  });
  it("returns the same object when nothing new is added", () => {
    const o = addOverride({}, "k", { domain: "a.com" });
    expect(addOverride(o, "k", { domain: "a.com" })).toBe(o);
    expect(addOverride(o, "k", {})).toBe(o);
  });
  it("parses stored overrides leniently", () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides([1, 2])).toEqual({});
    expect(parseOverrides({ k: { apps: ["a", 3], domains: "nope" }, bad: 5 })).toEqual({
      k: { apps: ["a"], domains: [] },
    });
  });
});

describe("isValidReason", () => {
  it("needs 10 characters after trimming", () => {
    expect(isValidReason(undefined)).toBe(false);
    expect(isValidReason("")).toBe(false);
    expect(isValidReason("   short    ")).toBe(false);
    expect(isValidReason("123456789")).toBe(false);
    expect(isValidReason("  1234567890  ")).toBe(true);
  });
  it("counts characters, not UTF-16 units", () => {
    expect(isValidReason("😀".repeat(9))).toBe(false);
    expect(isValidReason("😀".repeat(10))).toBe(true);
  });
});

describe("timerStateFromStatus", () => {
  it("maps Timer.tsx statuses", () => {
    expect(timerStateFromStatus("focusing")).toBe("running");
    expect(timerStateFromStatus("paused")).toBe("paused");
    expect(timerStateFromStatus("set timer")).toBe("idle");
    expect(timerStateFromStatus("time's up")).toBe("idle");
  });
});

describe("buildGuardConfig", () => {
  const prefs = { ...DEFAULT_GUARD_PREFS, enabled: true };
  it("sends the task, its allow-list and the workday days", () => {
    const c = buildGuardConfig(prefs, { text: "Fix Focusbox bug", done: false }, "running", {});
    expect(c.hasTask).toBe(true);
    expect(c.taskKey).toBe("fix focusbox bug");
    expect(c.allowDomains).toContain("github.com");
    expect(c.workday.days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(c.graceSecs).toBe(30);
    expect(c.blur).toBe(true);
  });
  it("treats a done or missing card as no task", () => {
    expect(buildGuardConfig(prefs, { text: "x", done: true }, "running", {}).hasTask).toBe(false);
    expect(buildGuardConfig(prefs, null, "running", {})).toMatchObject({ hasTask: false, taskText: "", allowApps: [] });
  });
});

describe("prefs", () => {
  beforeEach(() => localStorage.clear());
  it("default to off with a 30s grace and a 10-19 Bangkok workday", () => {
    expect(getGuardPrefs()).toEqual(DEFAULT_GUARD_PREFS);
    expect(DEFAULT_GUARD_PREFS.enabled).toBe(false);
  });
  it("round-trip through localStorage", () => {
    const p = { ...DEFAULT_GUARD_PREFS, enabled: true, graceSecs: 60, workday: { ...DEFAULT_GUARD_PREFS.workday, enabled: true, start: "09:30" } };
    storeGuardPrefs(p);
    expect(getGuardPrefs()).toEqual(p);
  });
  it("reject bad values field by field", () => {
    expect(normalizePrefs({ enabled: "yes", graceSecs: 7, workday: { start: "25:00", end: "9", tz: "  " } })).toEqual(
      DEFAULT_GUARD_PREFS,
    );
    localStorage.setItem("focusbox-focus-guard", "{not json");
    expect(getGuardPrefs()).toEqual(DEFAULT_GUARD_PREFS);
  });
});

describe("nudge opacity", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to 45% and reads back what was stored", () => {
    expect(getNudgeOpacity()).toBe(45);
    storeNudgeOpacity(70);
    expect(localStorage.getItem(NUDGE_OPACITY_KEY)).toBe("70");
    expect(getNudgeOpacity()).toBe(70);
  });
  it("clamps to 10–95, snaps to steps of 5 and rejects garbage", () => {
    expect(normalizeNudgeOpacity(0)).toBe(10);
    expect(normalizeNudgeOpacity(100)).toBe(95);
    expect(normalizeNudgeOpacity("62")).toBe(60);
    expect(normalizeNudgeOpacity(63)).toBe(65);
    expect(normalizeNudgeOpacity("abc")).toBe(45);
    expect(normalizeNudgeOpacity(null)).toBe(45);
    expect(normalizeNudgeOpacity("")).toBe(45);
    expect(normalizeNudgeOpacity(Number.NaN)).toBe(45);
    localStorage.setItem(NUDGE_OPACITY_KEY, "9999");
    expect(getNudgeOpacity()).toBe(95);
  });
  it("tint follows the setting, dark is heavier, and the card never drops below 92%", () => {
    expect(nudgeAlphas(45)).toEqual({ tint: 0.45, tintDark: 0.6, card: 0.92 });
    expect(nudgeAlphas(10)).toEqual({ tint: 0.1, tintDark: 0.25, card: 0.92 });
    expect(nudgeAlphas(70)).toEqual({ tint: 0.7, tintDark: 0.85, card: 0.95 });
    expect(nudgeAlphas(95)).toEqual({ tint: 0.95, tintDark: 1, card: 1 });
    for (let p = 10; p <= 95; p += 5) {
      const a = nudgeAlphas(p);
      expect(a.card).toBeGreaterThanOrEqual(0.92);
      expect(a.card).toBeGreaterThanOrEqual(a.tint);
      expect(a.tintDark).toBeGreaterThanOrEqual(a.tint);
    }
  });
  it("writes the CSS custom properties as percentages", () => {
    const props = new Map<string, string>();
    const el = { style: { setProperty: (k: string, v: string) => props.set(k, v) } } as unknown as HTMLElement;
    applyNudgeOpacity(el, 50);
    expect(Object.fromEntries(props)).toEqual({
      "--nudge-tint": "50%",
      "--nudge-tint-dark": "65%",
      "--nudge-card": "92%",
    });
  });
});

describe("parkResultMessage", () => {
  it("tells the user when the saved Todoist key was rejected", () => {
    expect(parkResultMessage("auth_blocked")).toMatch(/key rejected, check Settings/);
    expect(parkResultMessage("sent")).toBe("Parked in Todoist.");
  });
});

describe("off-Tauri", () => {
  it("reports the guard as unsupported", async () => {
    expect(await isGuardSupported()).toBe(false);
  });
});

describe("aggregateStats", () => {
  // Local-time timestamps so the day buckets don't depend on the machine's zone.
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const e = (over: Partial<GuardLogEntry>): GuardLogEntry => ({ ts: at(5, 10), kind: "drift", task: "Fix build", ...over });

  it("buckets per local day, newest first, and always includes today", () => {
    const out = aggregateStats([e({ ts: at(3, 23, 59) }), e({ ts: at(4, 0, 1) })], at(6, 9));
    expect(out.map((d) => d.day)).toEqual(["2026-10-06", "2026-10-04", "2026-10-03"]);
    expect(out[0]).toMatchObject({ focusedMinutes: 0, drifts: 0, topDrift: [], switches: [], parked: [] });
  });

  it("sums focused time into minutes", () => {
    const out = aggregateStats(
      [e({ kind: "focused_secs", secs: 60 }), e({ kind: "focused_secs", secs: 60 }), e({ kind: "focused_secs", secs: 45 })],
      at(5, 18),
    );
    expect(out[0].focusedMinutes).toBe(3); // 165s rounds to 3
  });

  it("counts drifts and ranks the top 5 sites/apps", () => {
    const drifts = [
      ...Array(4).fill(e({ domain: "youtube.com", app: "Google Chrome" })),
      ...Array(3).fill(e({ app: "Slack" })),
      e({ domain: "x.com" }),
      e({ domain: "reddit.com" }),
      e({ domain: "news.ycombinator.com" }),
      e({ app: "Mail" }),
    ];
    const [today] = aggregateStats(drifts, at(5, 18));
    expect(today.drifts).toBe(11);
    expect(today.topDrift).toEqual([
      { label: "youtube.com", count: 4 },
      { label: "Slack", count: 3 },
      { label: "Mail", count: 1 },
      { label: "news.ycombinator.com", count: 1 },
      { label: "reddit.com", count: 1 },
    ]);
  });

  it("collects switch reasons and parked items from both the nudge and the new-task prompt", () => {
    const [today] = aggregateStats(
      [
        e({ kind: "switch", reason: "server is down, urgent", ts: at(5, 11) }),
        e({ kind: "newtask_switch", reason: "client call moved up", ts: at(5, 12) }),
        e({ kind: "switch", ts: at(5, 13) }), // no reason: not listed
        e({ kind: "park", app: "Google Chrome", domain: "youtube.com", reason: "watch talk later", ts: at(5, 14) }),
        e({ kind: "newtask_park", task: "Reply to Anna", ts: at(5, 15) }),
        e({ kind: "back", reason: "was checking docs" }),
        e({ kind: "allow" }),
      ],
      at(5, 18),
    );
    expect(today.switches).toEqual([
      { task: "Fix build", reason: "server is down, urgent", ts: at(5, 11) },
      { task: "Fix build", reason: "client call moved up", ts: at(5, 12) },
    ]);
    expect(today.parked).toEqual([
      { text: "watch talk later", ts: at(5, 14) },
      { text: "Reply to Anna", ts: at(5, 15) },
    ]);
    expect(today.drifts).toBe(0);
  });

  it("reads the parked text from `text`, with the reason kept separately", () => {
    const [today] = aggregateStats(
      [e({ kind: "park", text: "read the RFC", reason: "third drift, got curious", ts: at(5, 9) })],
      at(5, 18),
    );
    expect(today.parked).toEqual([{ text: "read the RFC", ts: at(5, 9) }]);
  });

  it("localDay pads months and days", () => {
    expect(localDay(new Date(2026, 0, 2, 3).getTime())).toBe("2026-01-02");
  });
});
