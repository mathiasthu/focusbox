// Focus guard stats: today first, then previous days. Local only; read from the Rust-side
// JSONL log and bucketed by local day in focusGuard.ts.
import { useEffect, useState } from "react";
import { aggregateStats, guardStats, type DayStats } from "../lib/focusGuard";

const DAYS = 14;

function dayTitle(day: string, today: string): string {
  if (day === today) return "Today";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function minutes(n: number): string {
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)} h ${n % 60} min`;
}

function Day({ s, today }: { s: DayStats; today: string }) {
  const empty = !s.focusedMinutes && !s.awayMinutes && !s.drifts && !s.switches.length && !s.parked.length;
  return (
    <section className="guard-stats__day">
      <h3 className="guard-stats__title">{dayTitle(s.day, today)}</h3>
      {empty ? (
        <p className="setting__hint">Nothing recorded.</p>
      ) : (
        <>
          <div className="guard-stats__numbers">
            <span>
              <strong>{minutes(s.focusedMinutes)}</strong> focused
            </span>
            <span>
              <strong>{minutes(s.awayMinutes)}</strong> away
            </span>
            <span>
              <strong>{s.drifts}</strong> {s.drifts === 1 ? "drift" : "drifts"}
            </span>
          </div>
          {s.topDrift.length > 0 && (
            <div className="guard-stats__block">
              <span className="guard-stats__label">Pulled away by</span>
              <ul>
                {s.topDrift.map((d) => (
                  <li key={d.label}>
                    {d.label} <span className="guard-stats__count">×{d.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.switches.length > 0 && (
            <div className="guard-stats__block">
              <span className="guard-stats__label">Switched because</span>
              <ul>
                {s.switches.map((w) => (
                  <li key={w.ts}>
                    {w.reason} <span className="guard-stats__count">(from {w.task || "no task"})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.parked.length > 0 && (
            <div className="guard-stats__block">
              <span className="guard-stats__label">Parked</span>
              <ul>
                {s.parked.map((p) => (
                  <li key={p.ts}>{p.text}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function GuardStats({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState<DayStats[] | null>(null);
  const now = Date.now();
  const today = aggregateStats([], now)[0].day;

  useEffect(() => {
    let active = true;
    guardStats(DAYS).then((entries) => {
      if (active) setDays(aggregateStats(entries, Date.now()));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal guard-stats" role="dialog" aria-label="Focus guard stats" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2 className="modal__title">Focus stats</h2>
          <button className="modal__close" aria-label="Close stats" onClick={onClose}>
            ×
          </button>
        </header>
        {days === null ? (
          <p className="setting__hint">Loading…</p>
        ) : (
          days.map((s) => <Day key={s.day} s={s} today={today} />)
        )}
        <p className="modal__foot">Kept on this Mac for 90 days</p>
      </div>
    </div>
  );
}
