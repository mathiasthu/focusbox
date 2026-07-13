// The focus task under the timer. Active: text + done (✓) + remove-without-done (✕).
// Done: struck text, no buttons; stays until the timer is reset.
import type { FocusedTask } from "../lib/focusedLine";

interface Props {
  task: FocusedTask;
  onDone: () => void;
  onDismiss: () => void;
}

export default function FocusCard({ task, onDone, onDismiss }: Props) {
  return (
    <div className={`focus-card${task.done ? " focus-card--done" : ""}`}>
      <span className="focus-card__body">
        <span className="focus-card__label">Focus</span>
        {task.done ? (
          <span className="focus-card__text">{task.text || "…"}</span>
        ) : (
          <span
            className="focus-card__text focus-card__text--clickable"
            role="button"
            tabIndex={0}
            aria-label="Mark focus task done"
            title="Mark done"
            onClick={onDone}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onDone();
              }
            }}
          >
            {task.text || "…"}
          </span>
        )}
      </span>
      {task.done ? (
        <span className="focus-card__actions">
          <span className="focus-card__tag">done</span>
          <button
            type="button"
            className="focus-card__btn"
            aria-label="Dismiss focus task"
            title="Dismiss"
            onClick={onDismiss}
          >
            ✕
          </button>
        </span>
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
            aria-label="Remove focus task without completing"
            title="Remove"
            onClick={onDismiss}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
