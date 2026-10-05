import "./testDomShim";
import { describe, expect, it, beforeEach } from "vitest";
import {
  addAlwaysApp,
  addAlwaysDomain,
  appDisplayName,
  DEFAULT_ALWAYS_ALLOW,
  getAlwaysAllow,
  getPausedUntil,
  mergedAllow,
  normalizeHostname,
  normalizePausedUntil,
  parseAlwaysAllow,
  pauseUntil,
  removeAlwaysApp,
  removeAlwaysDomain,
  removeOverride,
  storeAlwaysAllow,
  storePausedUntil,
  toastCopy,
  truncateForToast,
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
    expect(c.blur).toBe(false);
    expect(c.idleAfterSecs).toBe(180);
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
  it("idle threshold: 1/2/3/5/10 minutes, default 3, anything else falls back", () => {
    expect(DEFAULT_GUARD_PREFS.idleMins).toBe(3);
    for (const m of [1, 2, 3, 5, 10]) expect(normalizePrefs({ idleMins: m }).idleMins).toBe(m);
    for (const bad of [0, 4, 15, -1, "5", null]) expect(normalizePrefs({ idleMins: bad }).idleMins).toBe(3);
  });

  it("blur defaults to Off and an old saved On is switched Off exactly once", () => {
    expect(DEFAULT_GUARD_PREFS.blur).toBe(false);
    // Saved by an older build: no version marker, blur On (the old default).
    localStorage.setItem("focusbox-focus-guard", JSON.stringify({ enabled: true, graceSecs: 60, blur: true }));
    const migrated = getGuardPrefs();
    expect(migrated.blur).toBe(false);
    expect(migrated.enabled).toBe(true);
    expect(migrated.graceSecs).toBe(60);
    expect(JSON.parse(localStorage.getItem("focusbox-focus-guard")!).v).toBe(2);
    // The user turns it back On: respected from now on.
    storeGuardPrefs({ ...migrated, blur: true });
    expect(getGuardPrefs().blur).toBe(true);
    expect(getGuardPrefs().blur).toBe(true);
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
    expect(normalizeNudgeOpacity(0)).toBe(5);
    expect(normalizeNudgeOpacity(5)).toBe(5);
    expect(normalizeNudgeOpacity(3)).toBe(5);
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
    expect(nudgeAlphas(5)).toEqual({ tint: 0.05, tintDark: 0.2, card: 0.92 });
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

describe("normalizeHostname", () => {
  it("strips scheme, www, userinfo, port, path and wildcard, then lowercases", () => {
    expect(normalizeHostname("https://WWW.GitHub.com/foo?x=1#y")).toBe("github.com");
    expect(normalizeHostname("  notion.so  ")).toBe("notion.so");
    expect(normalizeHostname("*.luxvps.net")).toBe("luxvps.net");
    expect(normalizeHostname("user@billing.luxvps.net:8443/admin")).toBe("billing.luxvps.net");
    expect(normalizeHostname("mail.google.com.")).toBe("mail.google.com");
  });
  it("rejects anything that isn't a dotted hostname", () => {
    for (const bad of ["", "localhost", "github", "not a site", "foo_bar.com", "-x.com", "x-.com", "a..com", "192.168.1.1", "https://", "/path/only"]) {
      expect(normalizeHostname(bad)).toBeNull();
    }
  });
});

describe("always-allowed list", () => {
  beforeEach(() => localStorage.clear());
  it("is seeded once with Claude, Terminal, iTerm, VS Code and claude.ai, then left alone", () => {
    expect(getAlwaysAllow()).toEqual(DEFAULT_ALWAYS_ALLOW);
    storeAlwaysAllow({ apps: [], domains: [] });
    expect(getAlwaysAllow()).toEqual({ apps: [], domains: [] }); // an emptied list stays empty
  });
  it("adds and removes apps and sites without duplicates", () => {
    let a = { apps: [], domains: [] } as ReturnType<typeof getAlwaysAllow>;
    a = addAlwaysApp(a, { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" });
    expect(addAlwaysApp(a, { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" })).toBe(a);
    const r = addAlwaysDomain(a, "https://www.Figma.com/file/x");
    expect(r.error).toBeUndefined();
    a = r.next;
    expect(a.domains).toEqual(["figma.com"]);
    expect(addAlwaysDomain(a, "figma.com").error).toMatch(/already/);
    expect(addAlwaysDomain(a, "not a site").error).toBeTruthy();
    a = removeAlwaysDomain(removeAlwaysApp(a, "com.tinyspeck.slackmacgap"), "figma.com");
    expect(a).toEqual({ apps: [], domains: [] });
  });
  it("parses stored data leniently", () => {
    expect(
      parseAlwaysAllow({
        apps: [{ bundleId: "x.y" }, { bundleId: "" }, 7, { bundleId: "x.y", name: "dup" }],
        domains: ["GitHub.com", "bad", 3, "github.com"],
      }),
    ).toEqual({ apps: [{ bundleId: "x.y", name: "x.y" }], domains: ["github.com"] });
    expect(parseAlwaysAllow("nope")).toEqual({ apps: [], domains: [] });
  });
  it("shows known apps by name", () => {
    expect(appDisplayName("com.microsoft.VSCode")).toBe("VS Code");
    expect(appDisplayName("a.b", [{ bundleId: "a.b", name: "Thing" }])).toBe("Thing");
    expect(appDisplayName("unknown.app")).toBe("unknown.app");
  });
});

describe("allow-list merge", () => {
  it("unions keyword defaults, the task's overrides and the always list", () => {
    const always = { apps: [{ bundleId: "com.apple.Terminal", name: "Terminal" }], domains: ["claude.ai", "figma.com"] };
    const overrides = { "send dms": { apps: ["com.apple.Notes"], domains: ["facebook.com"] } };
    expect(mergedAllow("Send DMs", overrides, always)).toEqual({
      apps: ["com.apple.Notes", "com.apple.Terminal"],
      domains: ["instagram.com", "facebook.com", "claude.ai", "figma.com"],
    });
    const code = mergedAllow("fix bug", {}, always);
    expect(code.apps.filter((a) => a === "com.apple.Terminal")).toHaveLength(1);
    expect(code.domains.filter((d) => d === "claude.ai")).toHaveLength(1);
    expect(mergedAllow("   ", overrides, always)).toEqual({ apps: [], domains: [] });
  });
  it("buildGuardConfig sends the merged list and the pause", () => {
    const c = buildGuardConfig(
      { ...DEFAULT_GUARD_PREFS, enabled: true },
      { text: "think", done: false },
      "running",
      {},
      { apps: [{ bundleId: "a.b", name: "A" }], domains: ["x.com"] },
      12345.9,
    );
    expect(c.allowApps).toEqual(["a.b"]);
    expect(c.allowDomains).toEqual(["x.com"]);
    expect(c.pausedUntil).toBe(12345);
  });
  it("removeOverride drops one entry and the task once empty", () => {
    const o = { k: { apps: ["a"], domains: ["x.com"] } };
    const one = removeOverride(o, "k", { app: "a" });
    expect(one).toEqual({ k: { apps: [], domains: ["x.com"] } });
    expect(removeOverride(one, "k", { domain: "x.com" })).toEqual({});
    expect(removeOverride(o, "k", { app: "zzz" })).toBe(o);
    expect(removeOverride(o, "missing", { app: "a" })).toBe(o);
  });
});

describe("pause", () => {
  beforeEach(() => localStorage.clear());
  const now = 1_700_000_000_000;
  it("clamps the length to 1–240 minutes", () => {
    expect(pauseUntil(now, 15)).toBe(now + 15 * 60_000);
    expect(pauseUntil(now, 0)).toBe(now + 60_000);
    expect(pauseUntil(now, 10_000)).toBe(now + 240 * 60_000);
    expect(pauseUntil(now, Number.NaN)).toBe(now + 15 * 60_000);
  });
  it("expires: a past, garbage or absurdly distant pause reads as none", () => {
    expect(normalizePausedUntil(now + 1000, now)).toBe(now + 1000);
    expect(normalizePausedUntil(now, now)).toBe(0);
    expect(normalizePausedUntil(now - 1, now)).toBe(0);
    expect(normalizePausedUntil("abc", now)).toBe(0);
    expect(normalizePausedUntil(now + 2 * 24 * 3600_000, now)).toBe(0);
  });
  it("survives a restart via localStorage, and Resume clears it", () => {
    storePausedUntil(now + 30 * 60_000);
    expect(getPausedUntil(now)).toBe(now + 30 * 60_000);
    expect(getPausedUntil(now + 31 * 60_000)).toBe(0); // auto-expired
    storePausedUntil(0);
    expect(localStorage.getItem("focusbox-guard-paused-until")).toBeNull();
  });
});

describe("park toast", () => {
  it("maps each park result to its copy", () => {
    expect(toastCopy("sent")).toEqual({ title: "Parked in Todoist", ok: true });
    expect(toastCopy("queued")).toEqual({ title: "Saved, goes to Todoist when you're online", ok: false });
    expect(toastCopy("no_token")).toEqual({ title: "Saved. Add your Todoist key in Settings", ok: false });
    expect(toastCopy("auth_blocked")).toEqual({ title: "Todoist key rejected. Saved until fixed", ok: false });
    expect(toastCopy("rejected").ok).toBe(false);
    expect(toastCopy("something new").title).toBe("Parked");
  });
  it("truncates the parked text to 40 characters with an ellipsis", () => {
    expect(truncateForToast("  Reply to   Anna  ")).toBe("Reply to Anna");
    const forty = "x".repeat(40);
    expect(truncateForToast(forty)).toBe(forty);
    const long = "Look into the weird caching bug in the sync server tomorrow";
    const out = truncateForToast(long);
    expect(out.endsWith("…")).toBe(true);
    expect([...out].length).toBeLessThanOrEqual(40);
    expect(out).toBe("Look into the weird caching bug in the…");
    expect(truncateForToast("😀".repeat(41))).toBe("😀".repeat(39) + "…");
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

  it("sums away time into minutes, separately from focused time", () => {
    const [today] = aggregateStats(
      [
        e({ kind: "away_secs", secs: 60 }),
        e({ kind: "away_secs", secs: 60 }),
        e({ kind: "away_secs", secs: 40 }),
        e({ kind: "focused_secs", secs: 60 }),
      ],
      at(5, 18),
    );
    expect(today.awayMinutes).toBe(3); // 160s rounds to 3
    expect(today.focusedMinutes).toBe(1);
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
