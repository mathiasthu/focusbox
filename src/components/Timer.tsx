import { useEffect, useRef, useState } from "react";

const PRESETS = [
  { label: "30", unit: "min", sec: 30 * 60 },
  { label: "1", unit: "h", sec: 60 * 60 },
  { label: "1.5", unit: "h", sec: 90 * 60 },
  { label: "2", unit: "h", sec: 120 * 60 },
];

const R = 92;
const CIRC = 2 * Math.PI * R;

function format(totalSec: number): string {
  const s = Math.max(0, totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function clampInt(value: string, max: number): number {
  const n = parseInt(value.replace(/\D/g, ""), 10);
  if (Number.isNaN(n)) return 0;
  return Math.min(Math.max(n, 0), max);
}

export default function Timer() {
  const [durationSec, setDurationSec] = useState(30 * 60);
  // Remaining time in milliseconds — drives both the readout and the ring.
  const [remainingMs, setRemainingMs] = useState(30 * 60 * 1000);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  // Absolute wall-clock time (ms) the countdown should reach zero.
  const endRef = useRef(0);

  // Timestamp-driven countdown: compute remaining from a target end time on
  // every animation frame. Accurate (no setInterval drift) and smooth.
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = () => {
      const remaining = endRef.current - Date.now();
      if (remaining <= 0) {
        setRemainingMs(0);
        setRunning(false);
        setFinished(true);
        return;
      }
      setRemainingMs(remaining);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const durationMs = durationSec * 1000;
  // Edit mode only when stopped at the full set duration (fresh / reset).
  const editable = !running && !finished && remainingMs === durationMs;
  const fraction = durationMs > 0 ? Math.max(0, remainingMs / durationMs) : 0;
  const dashOffset = CIRC * (1 - fraction);
  const displaySec = Math.ceil(remainingMs / 1000);

  const status = finished
    ? "time's up"
    : running
      ? "focusing"
      : remainingMs !== durationMs
        ? "paused"
        : "set timer";

  function setDuration(sec: number) {
    const safe = Math.max(0, sec);
    setDurationSec(safe);
    setRemainingMs(safe * 1000);
    setFinished(false);
  }

  function onEditField(part: "min" | "sec", raw: string) {
    const mins = part === "min" ? clampInt(raw, 999) : Math.floor(durationSec / 60);
    const secs = part === "sec" ? clampInt(raw, 59) : durationSec % 60;
    setDuration(mins * 60 + secs);
  }

  function start() {
    if (remainingMs <= 0) return;
    endRef.current = Date.now() + remainingMs;
    setFinished(false);
    setRunning(true);
  }
  function pause() {
    setRunning(false); // remainingMs already holds the current value
  }
  function reset() {
    setRunning(false);
    setFinished(false);
    setRemainingMs(durationMs);
  }

  return (
    <section className={`timer${finished ? " timer--finished" : ""}`}>
      <div className="dial">
        <svg className="dial__svg" viewBox="0 0 200 200" aria-hidden="true">
          <circle className="dial__track" cx="100" cy="100" r={R} />
          <circle
            className="dial__progress"
            cx="100"
            cy="100"
            r={R}
            style={{
              strokeDasharray: CIRC,
              strokeDashoffset: dashOffset,
            }}
          />
        </svg>

        <div className="dial__center">
          {editable ? (
            <div className="dial__edit">
              <input
                className="dial__field"
                type="text"
                inputMode="numeric"
                aria-label="Minutes"
                value={String(Math.floor(durationSec / 60)).padStart(2, "0")}
                onChange={(e) => onEditField("min", e.target.value)}
                onFocus={(e) => e.target.select()}
              />
              <span className="dial__colon">:</span>
              <input
                className="dial__field"
                type="text"
                inputMode="numeric"
                aria-label="Seconds"
                value={String(durationSec % 60).padStart(2, "0")}
                onChange={(e) => onEditField("sec", e.target.value)}
                onFocus={(e) => e.target.select()}
              />
            </div>
          ) : (
            <div className="dial__readout" aria-live="polite">
              {format(displaySec)}
            </div>
          )}
          <span className="dial__status">{status}</span>
        </div>
      </div>

      {editable && (
        <div className="timer__presets">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className={`chip${durationSec === p.sec ? " chip--active" : ""}`}
              onClick={() => setDuration(p.sec)}
            >
              {p.label}
              <span className="chip__unit">{p.unit}</span>
            </button>
          ))}
        </div>
      )}

      <div className="timer__controls">
        {!running && !finished && (
          <button className="btn btn--primary" onClick={start} disabled={remainingMs <= 0}>
            Start
          </button>
        )}
        {running && (
          <button className="btn" onClick={pause}>
            Pause
          </button>
        )}
        {!running && !finished && remainingMs !== durationMs && (
          <button className="btn btn--ghost" onClick={reset}>
            Reset
          </button>
        )}
        {finished && (
          <button className="btn btn--primary" onClick={reset}>
            Reset
          </button>
        )}
      </div>
    </section>
  );
}
