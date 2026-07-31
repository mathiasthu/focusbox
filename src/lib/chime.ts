// "Timer sound": the preference pair (on/off + which sound) and the sounds
// themselves — short tones played when the countdown reaches zero. Default OFF —
// a focus app shouldn't start making noise on an existing user's machine without
// them asking for it.
//
// The tones are synthesised with WebAudio rather than shipped as audio files: no
// binary assets, no media paths to whitelist in the Tauri CSP, and they work
// identically in the browser preview.
import { isDemo } from "./demo";

const KEY = "focusbox-chime";
const SOUND_KEY = "focusbox-chime-sound";

export type SoundId = "bell" | "chime" | "ping" | "marimba" | "digital";

export const DEFAULT_SOUND: SoundId = "bell";

/** One scheduled oscillator: when it starts (seconds after the sound begins), its
 * pitch, peak level and how long it takes to fade out. Every sound below is just a
 * list of these, which keeps the sounds declarative and the renderer in one place. */
interface Voice {
  delay: number;
  hz: number;
  /** peak gain, 0–1. Sines sit around 0.1; square waves need roughly half that. */
  level: number;
  /** seconds from attack to (near) silence */
  decay: number;
  type?: OscillatorType;
  /** optional pitch glide target, reached at the end of the decay */
  bendTo?: number;
}

// A struck bell: partials at non-integer ratios (that stretch is what stops it
// reading as a plain beep), upper ones fading first, hit twice.
function bellStrike(delay: number, gain: number): Voice[] {
  return [
    { delay, hz: 880, level: 0.1 * gain, decay: 1.5 },
    { delay, hz: 1760, level: 0.04 * gain, decay: 0.9 },
    { delay, hz: 2428.8, level: 0.017 * gain, decay: 0.55 },
  ];
}

// Three rising notes, each a soft bell — a doorbell rather than an alarm.
function chimeNote(delay: number, hz: number): Voice[] {
  return [
    { delay, hz, level: 0.09, decay: 1.3 },
    { delay, hz: hz * 2, level: 0.025, decay: 0.7 },
  ];
}

// Wooden mallet: the 4:1 upper mode is the marimba's signature, and it dies away
// almost immediately, leaving the fundamental to ring.
function marimbaNote(delay: number, hz: number): Voice[] {
  return [
    { delay, hz, level: 0.11, decay: 0.55 },
    { delay, hz: hz * 4, level: 0.03, decay: 0.16 },
  ];
}

const VOICES: Record<SoundId, Voice[]> = {
  bell: [...bellStrike(0, 1), ...bellStrike(0.34, 0.75)],
  chime: [...chimeNote(0, 659.25), ...chimeNote(0.16, 880), ...chimeNote(0.32, 1108.73)],
  // Single crisp blip with a slight downward glide, so it lands rather than hangs.
  ping: [
    { delay: 0, hz: 1318.5, level: 0.1, decay: 0.45, bendTo: 1244.5 },
    { delay: 0, hz: 2637, level: 0.02, decay: 0.18 },
  ],
  marimba: [...marimbaNote(0, 523.25), ...marimbaNote(0.13, 783.99)],
  // Retro three-blip beeper.
  digital: [
    { delay: 0, hz: 1046.5, level: 0.045, decay: 0.09, type: "square" },
    { delay: 0.13, hz: 1046.5, level: 0.045, decay: 0.09, type: "square" },
    { delay: 0.26, hz: 1046.5, level: 0.045, decay: 0.09, type: "square" },
  ],
};

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: "bell", label: "Bell" },
  { id: "chime", label: "Chime" },
  { id: "ping", label: "Ping" },
  { id: "marimba", label: "Marimba" },
  { id: "digital", label: "Digital" },
];

/** Falls back to the default for anything unrecognised — a stored value from a
 * newer build, or a settings blob synced down from one. */
export function normalizeSoundId(value: unknown): SoundId {
  return SOUNDS.some((s) => s.id === value) ? (value as SoundId) : DEFAULT_SOUND;
}

// ---- preferences ----

export function getChime(): boolean {
  if (isDemo()) return false;
  return localStorage.getItem(KEY) === "1";
}

export function storeChime(enabled: boolean): void {
  if (isDemo()) return;
  localStorage.setItem(KEY, enabled ? "1" : "0");
}

export function getChimeSound(): SoundId {
  if (isDemo()) return DEFAULT_SOUND;
  return normalizeSoundId(localStorage.getItem(SOUND_KEY));
}

export function storeChimeSound(id: SoundId): void {
  if (isDemo()) return;
  localStorage.setItem(SOUND_KEY, id);
}

// ---- playback ----

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

function schedule(ac: AudioContext, voices: Voice[], t0: number) {
  for (const v of voices) {
    const at = t0 + v.delay;
    const osc = ac.createOscillator();
    osc.type = v.type ?? "sine";
    osc.frequency.setValueAtTime(v.hz, at);
    if (v.bendTo) osc.frequency.exponentialRampToValueAtTime(v.bendTo, at + v.decay);
    const g = ac.createGain();
    // Ramp up over a few ms instead of starting at full level: a hard start clicks.
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(v.level, at + 0.006);
    // exponentialRamp can't reach 0, so decay to a near-silent floor.
    g.gain.exponentialRampToValueAtTime(0.0001, at + v.decay);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start(at);
    osc.stop(at + v.decay + 0.05);
  }
}

/** Play a timer sound once. Safe to call anywhere — no-ops if WebAudio is missing. */
export function playChime(sound: SoundId = DEFAULT_SOUND): void {
  const ac = getCtx();
  if (!ac) return;
  // Autoplay policies start the context suspended until a user gesture. By the time
  // a timer can finish the user has clicked Start, so this resolves; ignore failures.
  if (ac.state === "suspended") void ac.resume().catch(() => {});
  schedule(ac, VOICES[normalizeSoundId(sound)], ac.currentTime + 0.02);
}
