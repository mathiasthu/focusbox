import { useState } from "react";
import type { SyncController } from "../hooks/useSync";

export default function DeleteAccount({ sync }: { sync: SyncController }) {
  const [arming, setArming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = !!sync.email && typed.trim().toLowerCase() === sync.email.toLowerCase();

  async function doDelete() {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sync.deleteAccount(); // manager returns to signed-out on success
    } catch {
      setError("Couldn't delete the account. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!arming) {
    return (
      <button className="account__btn account__btn--danger" onClick={() => setArming(true)}>
        Delete account
      </button>
    );
  }
  return (
    <div className="account__danger">
      <span className="setting__hint">
        This permanently deletes your synced data and cancels your subscription. Your tasks and
        notes stay on this device. Type your email to confirm.
      </span>
      <input
        className="account__input"
        type="email"
        autoComplete="off"
        placeholder={sync.email ?? "Email"}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        disabled={busy}
      />
      {error && <span className="account__error">{error}</span>}
      <div className="account__row">
        <button
          className="account__btn"
          onClick={() => {
            setArming(false);
            setTyped("");
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          className="account__btn account__btn--danger"
          onClick={() => void doDelete()}
          disabled={!armed || busy}
        >
          {busy ? "Deleting…" : "Delete account"}
        </button>
      </div>
    </div>
  );
}
