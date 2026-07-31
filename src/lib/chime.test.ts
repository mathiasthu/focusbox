import "./testDomShim";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getChime,
  storeChime,
  getChimeSound,
  storeChimeSound,
  normalizeSoundId,
  playChime,
  SOUNDS,
  DEFAULT_SOUND,
  type SoundId,
} from "./chime";

const KEY = "focusbox-chime";
const SOUND_KEY = "focusbox-chime-sound";

afterEach(() => {
  localStorage.removeItem(KEY);
  localStorage.removeItem(SOUND_KEY);
  window.history.replaceState({}, "", "/");
});

describe("timer sound preference", () => {
  it("defaults to OFF when nothing is stored (never surprise an existing user with sound)", () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getChime()).toBe(false);
  });

  it("persists ON and reads it back", () => {
    storeChime(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    expect(getChime()).toBe(true);
  });

  it("persists OFF explicitly and reads it back", () => {
    storeChime(true);
    storeChime(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    expect(getChime()).toBe(false);
  });

  it("is off in demo mode regardless of stored value, and does not write", () => {
    storeChime(true);
    window.history.replaceState({}, "", "/demo");
    expect(getChime()).toBe(false);
    storeChime(false);
    // demo mode never writes — the earlier "1" from before entering demo mode remains.
    expect(localStorage.getItem(KEY)).toBe("1");
  });
});

describe("sound choice", () => {
  it("defaults to the bell", () => {
    expect(DEFAULT_SOUND).toBe("bell");
    expect(getChimeSound()).toBe("bell");
  });

  it("round-trips every sound in the picker", () => {
    for (const s of SOUNDS) {
      storeChimeSound(s.id);
      expect(getChimeSound()).toBe(s.id);
    }
  });

  it("falls back to the default for an unknown stored value", () => {
    // e.g. a value written by a newer build, or synced down from one.
    localStorage.setItem(SOUND_KEY, "theremin");
    expect(getChimeSound()).toBe(DEFAULT_SOUND);
    expect(normalizeSoundId("theremin")).toBe(DEFAULT_SOUND);
    expect(normalizeSoundId(null)).toBe(DEFAULT_SOUND);
    expect(normalizeSoundId(undefined)).toBe(DEFAULT_SOUND);
    expect(normalizeSoundId("gong")).toBe("gong");
  });

  it("moves anyone on a retired sound back to the default", () => {
    for (const retired of ["ping", "marimba", "digital"]) {
      localStorage.setItem(SOUND_KEY, retired);
      expect(getChimeSound()).toBe(DEFAULT_SOUND);
    }
    expect(SOUNDS.map((s) => s.id)).not.toContain("ping");
  });

  it("is the default in demo mode, and does not write", () => {
    storeChimeSound("gong");
    window.history.replaceState({}, "", "/demo");
    expect(getChimeSound()).toBe(DEFAULT_SOUND);
    storeChimeSound("harp");
    expect(localStorage.getItem(SOUND_KEY)).toBe("gong");
  });
});

describe("playChime without WebAudio", () => {
  // Runs before any test below caches a context, so nothing to restore beyond the
  // constructor itself.
  it("no-ops instead of throwing", () => {
    const w = window as unknown as { AudioContext?: unknown };
    const saved = w.AudioContext;
    delete w.AudioContext;
    expect(() => playChime()).not.toThrow();
    expect(started).toHaveLength(0);
    w.AudioContext = saved;
  });
});

// ---- playback, against a stub AudioContext ----

interface Started {
  type: string;
  hz: number;
  start: number;
  stop: number;
  peak: number;
  /** seconds from start to peak level */
  attack: number;
}

const started: Started[] = [];

class StubParam {
  last = 0;
  constructor(private readonly onSet?: (v: number, t: number) => void) {}
  setValueAtTime(v: number, t: number) {
    this.last = v;
    this.onSet?.(v, t);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.last = v;
    this.onSet?.(v, t);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (v === 0) throw new RangeError("exponentialRamp cannot reach zero");
    this.last = v;
    this.onSet?.(v, t);
  }
}

class StubOsc {
  type = "sine";
  hz = 0;
  frequency = new StubParam((v) => {
    // First scheduled value is the pitch; a later one is the glide target.
    if (this.hz === 0) this.hz = v;
  });
  peak = 0;
  peakAt = -1;
  startedAt = -1;
  connect() {}
  start(t: number) {
    this.startedAt = t;
  }
  stop(t: number) {
    started.push({
      type: this.type,
      hz: this.hz,
      start: this.startedAt,
      stop: t,
      peak: this.peak,
      attack: this.peakAt - this.startedAt,
    });
  }
}

class StubGain {
  osc: StubOsc | null = null;
  gain = new StubParam((v, t) => {
    if (!this.osc) return;
    this.osc.peak = Math.max(this.osc.peak, v);
    // The first meaningful ramp is the attack; the later one is the decay to the
    // near-silent floor (0.0001), which must not be mistaken for it.
    if (v > 0.001 && this.osc.peakAt < 0) this.osc.peakAt = t;
  });
  connect() {}
}

class StubAudioContext {
  state = "suspended";
  currentTime = 5; // non-zero, so "scheduled relative to now" bugs surface
  destination = {};
  private pendingOsc: StubOsc | null = null;
  createOscillator() {
    const o = new StubOsc();
    this.pendingOsc = o;
    return o;
  }
  createGain() {
    const g = new StubGain();
    g.osc = this.pendingOsc; // each voice creates its oscillator then its gain
    return g;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
}

beforeAll(() => {
  (window as unknown as { AudioContext: unknown }).AudioContext = StubAudioContext;
});

beforeEach(() => {
  started.length = 0;
});

describe("playChime", () => {
  const counts: Record<SoundId, number> = {
    bell: 6, // 3 partials x 2 strikes
    chime: 6, // 2 partials x 3 notes
    gong: 5, // 5 partials, one strike
    bowl: 3, // 2 beating fundamentals + 1 partial
    harp: 12, // 3 partials x 4 notes
  };

  for (const { id, label } of SOUNDS) {
    it(`schedules ${label}`, () => {
      playChime(id);
      expect(started).toHaveLength(counts[id]);
      for (const v of started) {
        // Everything is scheduled in the future, audible, sane in level, and stops
        // after it starts — a voice that violates any of these is silent or a click.
        expect(v.start).toBeGreaterThanOrEqual(5);
        expect(v.stop).toBeGreaterThan(v.start);
        expect(v.hz).toBeGreaterThan(100);
        expect(v.hz).toBeLessThan(8000);
        expect(v.peak).toBeGreaterThan(0);
        expect(v.peak).toBeLessThanOrEqual(0.2);
      }
      // More than one voice means they must not all land at once.
      if (started.length > 1) {
        expect(new Set(started.map((v) => `${v.hz}@${v.start}`)).size).toBe(started.length);
      }
    });
  }

  it("gives each sound a distinct fingerprint", () => {
    const prints = SOUNDS.map(({ id }) => {
      started.length = 0;
      playChime(id);
      return JSON.stringify(started.map((v) => [v.type, v.hz, v.start]));
    });
    expect(new Set(prints).size).toBe(SOUNDS.length);
  });

  it("keeps every sound to sine partials (the set is acoustic, not a beeper)", () => {
    for (const { id } of SOUNDS) {
      started.length = 0;
      playChime(id);
      expect(started.every((v) => v.type === "sine")).toBe(true);
    }
  });

  it("gives every voice a non-zero attack, and the bowl a swell rather than a strike", () => {
    for (const { id } of SOUNDS) {
      started.length = 0;
      playChime(id);
      // A zero-length attack is an audible click, so nothing may start at full level.
      expect(started.every((v) => v.attack > 0)).toBe(true);
      const slowest = Math.max(...started.map((v) => v.attack));
      if (id === "bowl") expect(slowest).toBeGreaterThan(0.05);
      else expect(slowest).toBeLessThan(0.02);
    }
  });

  it("falls back to the default sound for an unknown id and resumes a suspended context", () => {
    playChime("marimba" as SoundId); // retired, so it must not resolve to anything
    const bogus = [...started];
    started.length = 0;
    playChime("bell");
    expect(bogus.map((v) => v.hz)).toEqual(started.map((v) => v.hz));
  });
});
