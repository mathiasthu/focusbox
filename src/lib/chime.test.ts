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
    expect(normalizeSoundId("marimba")).toBe("marimba");
  });

  it("is the default in demo mode, and does not write", () => {
    storeChimeSound("digital");
    window.history.replaceState({}, "", "/demo");
    expect(getChimeSound()).toBe(DEFAULT_SOUND);
    storeChimeSound("ping");
    expect(localStorage.getItem(SOUND_KEY)).toBe("digital");
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
  startedAt = -1;
  connect() {}
  start(t: number) {
    this.startedAt = t;
  }
  stop(t: number) {
    started.push({ type: this.type, hz: this.hz, start: this.startedAt, stop: t, peak: this.peak });
  }
}

class StubGain {
  osc: StubOsc | null = null;
  gain = new StubParam((v) => {
    if (this.osc) this.osc.peak = Math.max(this.osc.peak, v);
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
    ping: 2,
    marimba: 4, // 2 partials x 2 notes
    digital: 3,
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

  it("uses square waves only for the digital beeper", () => {
    playChime("digital");
    expect(started.every((v) => v.type === "square")).toBe(true);
    for (const { id } of SOUNDS.filter((s) => s.id !== "digital")) {
      started.length = 0;
      playChime(id);
      expect(started.every((v) => v.type === "sine")).toBe(true);
    }
  });

  it("falls back to the default sound for an unknown id and resumes a suspended context", () => {
    playChime("gong" as SoundId);
    const bogus = [...started];
    started.length = 0;
    playChime("bell");
    expect(bogus.map((v) => v.hz)).toEqual(started.map((v) => v.hz));
  });
});
