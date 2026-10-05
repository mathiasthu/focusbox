// Quiet in-app reminder under the timer: a Focus card is set but its timer was never
// started. In the main window only; no OS window, no toast, no sound. When to show it is
// decided in src/lib/timerPrompt.ts.
interface Props {
  onStart: () => void;
  onDismiss: () => void;
}

export default function StartTimerPrompt({ onStart, onDismiss }: Props) {
  return (
    <div className="start-prompt" role="status" aria-live="polite">
      <span className="start-prompt__text">Start the timer for this task?</span>
      <span className="start-prompt__actions">
        <button type="button" className="btn btn--primary start-prompt__btn" onClick={onStart}>
          Start timer
        </button>
        <button type="button" className="btn start-prompt__btn" onClick={onDismiss}>
          Not now
        </button>
      </span>
    </div>
  );
}
