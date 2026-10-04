// Focus guard: "you're already on something" prompt, shown when a different line is
// focused (drag-drop or the toolbar button) while the current Focus task is unfinished.
// Park it sends the NEW line to Todoist and keeps the current focus; the line itself stays
// in the notes untouched. Switch (unless "Block completely" is on) needs a typed reason.
import { useEffect, useState } from "react";
import { isValidReason, MIN_REASON_CHARS, parkResultMessage } from "../lib/focusGuard";

interface Props {
  current: string;
  next: string;
  blockCompletely: boolean;
  onPark: () => Promise<string>;
  onSwitch: (reason: string) => void;
  onCancel: () => void;
}

export default function NewTaskGuard({ current, next, blockCompletely, onPark, onSwitch, onCancel }: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Parked, but not delivered yet (no key / key rejected): say so and offer only Close.
  const [parkedPending, setParkedPending] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  async function park() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await onPark();
      if (r === "rejected" || r === "no_token" || r === "auth_blocked") {
        setMessage(parkResultMessage(r));
        setParkedPending(r !== "rejected");
        setBusy(false);
      }
    } catch (err) {
      setMessage(`Couldn't park it: ${String(err)}`);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal newtask" role="dialog" aria-label="Already focused" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2 className="modal__title">You're on: {current || "…"}</h2>
        </header>
        <p className="newtask__next">
          Starting <strong>{next || "this line"}</strong> now would leave that unfinished.
          {blockCompletely ? " Park it for later." : " Park it for later, or switch with a reason."}
        </p>
        <div className="account__row">
          {!parkedPending && (
            <button type="button" className="account__btn account__btn--primary" disabled={busy} onClick={() => void park()}>
              Park it
            </button>
          )}
          <button type="button" className="account__btn" disabled={busy} onClick={onCancel}>
            {parkedPending ? "Close" : "Cancel"}
          </button>
        </div>
        {!blockCompletely && !parkedPending && (
          <div className="newtask__switch">
            <label className="setting__hint" htmlFor="newtask-reason">
              Switch anyway. Why? ({MIN_REASON_CHARS}+ characters)
            </label>
            <textarea
              id="newtask-reason"
              className="account__input"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className="account__btn"
              disabled={busy || !isValidReason(reason)}
              onClick={() => onSwitch(reason.trim())}
            >
              Switch with reason
            </button>
          </div>
        )}
        {message && <p className="account__error">{message}</p>}
      </div>
    </div>
  );
}
