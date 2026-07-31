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

export type SoundId = "bell" | "chime" | "gong" | "bowl" | "harp";

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
  /** seconds to reach peak level. The few-ms default reads as a strike; longer
   * values swell instead (the singing bowl). Never 0 — that clicks. */
  attack?: number;
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

// A plucked string: bright for an instant (the 2nd and 3rd partials go first),
// then just the fundamental ringing.
function harpNote(delay: number, hz: number): Voice[] {
  return [
    { delay, hz, level: 0.075, decay: 0.9, attack: 0.004 },
    { delay, hz: hz * 2, level: 0.02, decay: 0.45, attack: 0.004 },
    { delay, hz: hz * 3, level: 0.01, decay: 0.25, attack: 0.004 },
  ];
}

const VOICES: Record<SoundId, Voice[]> = {
  bell: [...bellStrike(0, 1), ...bellStrike(0.34, 0.75)],
  chime: [...chimeNote(0, 659.25), ...chimeNote(0.16, 880), ...chimeNote(0.32, 1108.73)],
  // Low and dark, with dense inharmonic partials over a long tail — the deep end
  // of the set, where the bell is the bright one.
  gong: [
    { delay: 0, hz: 130.81, level: 0.1, decay: 2.6, attack: 0.012 },
    { delay: 0, hz: 193.6, level: 0.05, decay: 2 },
    { delay: 0, hz: 278.6, level: 0.035, decay: 1.4 },
    { delay: 0, hz: 418.6, level: 0.022, decay: 0.9 },
    { delay: 0, hz: 561, level: 0.015, decay: 0.55 },
  ],
  // Singing bowl: no strike at all, just a swell. The two near-identical pitches
  // beat slowly against each other, which is the shimmer a real bowl has.
  bowl: [
    { delay: 0, hz: 440, level: 0.075, decay: 2.4, attack: 0.09 },
    { delay: 0, hz: 440.9, level: 0.075, decay: 2.4, attack: 0.09 },
    { delay: 0, hz: 1174.7, level: 0.02, decay: 1.2, attack: 0.05 },
  ],
  // A fast rolled arpeggio — the notes overlap, unlike the chime's spaced ding-dong.
  harp: [
    ...harpNote(0, 440),
    ...harpNote(0.075, 554.37),
    ...harpNote(0.15, 659.25),
    ...harpNote(0.225, 880),
  ],
};

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: "bell", label: "Bell" },
  { id: "chime", label: "Chime" },
  { id: "gong", label: "Gong" },
  { id: "bowl", label: "Bowl" },
  { id: "harp", label: "Harp" },
];

/** Falls back to the default for anything unrecognised — a stored value from a
 * newer build, a settings blob synced down from one, or one of the retired sounds
 * ("ping" / "marimba" / "digital"), which is how anyone who had picked one gets
 * moved to the bell. */
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
    g.gain.linearRampToValueAtTime(v.level, at + (v.attack ?? 0.006));
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
