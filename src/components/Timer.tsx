import { useEffect, useRef, useState } from "react";

const PRESETS = [
  { label: "5", sec: 5 * 60 },
  { label: "15", sec: 15 * 60 },
  { label: "25", sec: 25 * 60 },
  { label: "50", sec: 50 * 60 },
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
  const [durationSec, setDurationSec] = useState(25 * 60);
  const [remainingSec, setRemainingSec] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  const fraction = durationSec > 0 ? remainingSec / durationSec : 0;
  const dashOffset = CIRC * (1 - fraction);

  const status = finished
    ? "time's up"
    : running
      ? "focusing"
      : remainingSec !== durationSec
        ? "paused"
        : "set timer";

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
      <div className="dial">
        <svg className="dial__svg" viewBox="0 0 200 200" aria-hidden="true">
          <circle className="dial__track" cx="100" cy="100" r={R} />
          <circle
            className={`dial__progress${running ? " dial__progress--animating" : ""}`}
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
              {format(remainingSec)}
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
              <span className="chip__unit">min</span>
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
            Reset
          </button>
        )}
      </div>
    </section>
  );
}
