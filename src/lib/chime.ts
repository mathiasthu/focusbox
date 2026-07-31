// "Timer sound" preference + the sound itself: a small two-strike bell played
// when the countdown reaches zero. Default OFF — a focus app shouldn't start
// making noise on an existing user's machine without them asking for it.
//
// The tone is synthesised with WebAudio rather than shipped as an audio file:
// no binary asset, no media path to whitelist in the Tauri CSP, and it works
// identically in the browser preview.
import { isDemo } from "./demo";

const KEY = "focusbox-chime";

export function getChime(): boolean {
  if (isDemo()) return false;
  return localStorage.getItem(KEY) === "1";
}

export function storeChime(enabled: boolean): void {
  if (isDemo()) return;
  localStorage.setItem(KEY, enabled ? "1" : "0");
}

// Inharmonic partials (multiplier, level, decay seconds) — the stretched, non-integer
// ratios are what make it read as a small bell instead of a beep. Upper partials fade
// first, as they do on a real one.
const PARTIALS: [number, number, number][] = [
  [1, 0.6, 1.5],
  [2, 0.24, 0.9],
  [2.76, 0.1, 0.55],
];

const BASE_HZ = 880;

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

function strike(ac: AudioContext, at: number, gain: number) {
  const out = ac.createGain();
  out.gain.setValueAtTime(gain, at);
  out.connect(ac.destination);
  for (const [mult, level, decay] of PARTIALS) {
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(BASE_HZ * mult, at);
    const g = ac.createGain();
    // Ramp up over a few ms instead of starting at full level: a hard start clicks.
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.006);
    // exponentialRamp can't reach 0, so decay to a near-silent floor.
    g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(g);
    g.connect(out);
    osc.start(at);
    osc.stop(at + decay + 0.05);
  }
}

/** Play the chime once. Safe to call anywhere — no-ops if WebAudio is missing. */
export function playChime(): void {
  const ac = getCtx();
  if (!ac) return;
  // Autoplay policies start the context suspended until a user gesture. By the time
  // a timer can finish the user has clicked Start, so this resolves; ignore failures.
  if (ac.state === "suspended") void ac.resume().catch(() => {});
  const now = ac.currentTime + 0.02;
  strike(ac, now, 0.16);
  strike(ac, now + 0.34, 0.12);
}
