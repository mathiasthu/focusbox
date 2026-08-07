import { useState } from "react";
import type { SyncController } from "../hooks/useSync";
import { checkPassword } from "../lib/passwordPolicy";

export default function RecoverForm({
  sync,
  onBack,
}: {
  sync: SyncController;
  onBack: () => void;
}) {
  const [email, setEmail] = useState(sync.email ?? "");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const pw = checkPassword(password, email);

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await sync.recover(email.trim(), recoveryKey.trim(), password);
      setPassword("");
      setRecoveryKey("");
    } catch {
      /* surfaced via sync.lastError */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setting setting--col account">
      <span className="setting__label">Reset password with recovery key</span>
      <span className="setting__hint">
        Enter the recovery key you saved at signup and a new password. Without the key we can't
        reset it for you. The key you enter here is used up — a replacement is shown once when
        the reset finishes.
      </span>
      <input
        className="account__input"
        type="email"
        autoComplete="username"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
      />
      <input
        className="account__input"
        type="text"
        autoComplete="off"
        placeholder="Recovery key"
        value={recoveryKey}
        onChange={(e) => setRecoveryKey(e.target.value)}
        disabled={busy}
      />
      <input
        className="account__input"
        type="password"
        autoComplete="new-password"
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      {password.length > 0 && pw.message && (
        <span className={pw.acceptable ? "setting__hint" : "account__error"}>{pw.message}</span>
      )}
      {sync.lastError && <span className="account__error">{sync.lastError}</span>}
      <div className="account__row">
        <button className="account__btn" onClick={onBack} disabled={busy}>
          Back to log in
        </button>
        <button
          className="account__btn account__btn--primary"
          onClick={() => void submit()}
          disabled={busy || !email.trim() || !recoveryKey.trim() || !pw.acceptable}
        >
          {busy ? "…" : "Reset password"}
        </button>
      </div>
    </div>
  );
}
