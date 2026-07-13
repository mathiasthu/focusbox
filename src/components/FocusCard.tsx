// The focus task under the timer. Active: text + done (✓) + dismiss-as-done (✕).
// Done: struck text, no buttons; stays until the timer is reset.
import type { FocusedTask } from "../lib/focusedLine";

interface Props {
  task: FocusedTask;
  onDone: () => void;
}

export default function FocusCard({ task, onDone }: Props) {
  return (
    <div className={`focus-card${task.done ? " focus-card--done" : ""}`}>
      <span className="focus-card__text">{task.text || "…"}</span>
      {task.done ? (
        <span className="focus-card__tag">done</span>
      ) : (
        <span className="focus-card__actions">
          <button
            type="button"
            className="focus-card__btn"
            aria-label="Mark focus task done"
            title="Done"
            onClick={onDone}
          >
            ✓
          </button>
          <button
            type="button"
            className="focus-card__btn"
            aria-label="Mark focus task done and dismiss"
            title="Done"
            onClick={onDone}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
