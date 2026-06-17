import { useEffect, useRef, useState } from "react";

const PRESETS = [
  { label: "5m", sec: 5 * 60 },
  { label: "15m", sec: 15 * 60 },
  { label: "25m", sec: 25 * 60 },
];

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
  const [durationSec, setDurationSec] = useState(25 * 60);
  const [remainingSec, setRemainingSec] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive the countdown.
  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setRemainingSec((prev) => {
        if (prev <= 1) {
          setRunning(false);
          setFinished(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const editable = !running && !finished;

  function setDuration(sec: number) {
    const safe = Math.max(0, sec);
    setDurationSec(safe);
    setRemainingSec(safe);
    setFinished(false);
  }

  function onEditField(part: "min" | "sec", raw: string) {
    const mins = part === "min" ? clampInt(raw, 999) : Math.floor(durationSec / 60);
    const secs = part === "sec" ? clampInt(raw, 59) : durationSec % 60;
    setDuration(mins * 60 + secs);
  }

  function start() {
    if (remainingSec <= 0) return;
    setFinished(false);
    setRunning(true);
  }

  function pause() {
    setRunning(false);
  }

  function reset() {
    setRunning(false);
    setFinished(false);
    setRemainingSec(durationSec);
  }

  return (
    <section className={`timer${finished ? " timer--finished" : ""}`}>
      {editable ? (
        <div className="timer__edit">
          <input
            className="timer__field"
            type="text"
            inputMode="numeric"
            aria-label="Minutes"
            value={String(Math.floor(durationSec / 60)).padStart(2, "0")}
            onChange={(e) => onEditField("min", e.target.value)}
            onFocus={(e) => e.target.select()}
          />
          <span className="timer__colon">:</span>
          <input
            className="timer__field"
            type="text"
            inputMode="numeric"
            aria-label="Seconds"
            value={String(durationSec % 60).padStart(2, "0")}
            onChange={(e) => onEditField("sec", e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </div>
      ) : (
        <div className="timer__display" aria-live="polite">
          {format(remainingSec)}
        </div>
      )}

      {editable && (
        <div className="timer__presets">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="chip"
              onClick={() => setDuration(p.sec)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="timer__controls">
        {!running && !finished && (
          <button className="btn btn--primary" onClick={start} disabled={remainingSec <= 0}>
            Start
          </button>
        )}
        {running && (
          <button className="btn" onClick={pause}>
            Pause
          </button>
        )}
        {!running && !finished && remainingSec !== durationSec && (
          <button className="btn btn--ghost" onClick={reset}>
            Reset
          </button>
        )}
        {finished && (
          <button className="btn btn--primary" onClick={reset}>
            Done — Reset
          </button>
        )}
      </div>
    </section>
  );
}
