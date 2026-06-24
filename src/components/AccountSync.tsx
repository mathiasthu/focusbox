import { useState } from "react";
import type { SyncController } from "../hooks/useSync";

function relativeTime(ts: number | null): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

interface Props {
  sync: SyncController;
}

export default function AccountSync({ sync }: Props) {
  const signedIn = sync.email !== null && sync.status !== "needs-relogin";
  const [email, setEmail] = useState(sync.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run(action: (e: string, p: string) => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action(email.trim(), password);
      setPassword("");
    } catch {
      // error is surfaced via sync.lastError
    } finally {
      setBusy(false);
    }
  }

  async function copyRecovery() {
    if (!sync.recoveryKey) return;
    try {
      await navigator.clipboard.writeText(sync.recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable; the key is still shown to copy by hand */
    }
  }

  // One-time recovery-key panel after signup — must be acknowledged before continuing.
  if (sync.recoveryKey) {
    return (
      <div className="setting setting--col account">
        <span className="setting__label">Save your recovery key</span>
        <span className="setting__hint">
          This is the only way to recover your encrypted data if you forget your password. We can't
          reset it for you — store it somewhere safe.
        </span>
        <code className="account__recovery">{sync.recoveryKey}</code>
        <div className="account__row">
          <button className="account__btn" onClick={copyRecovery}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button
            className="account__btn account__btn--primary"
            onClick={() => sync.dismissRecoveryKey()}
          >
            I've saved it
          </button>
        </div>
      </div>
    );
  }

  if (!signedIn) {
    const relogin = sync.status === "needs-relogin";
    return (
      <div className="setting setting--col account">
        <span className="setting__label">Cloud sync</span>
        <span className="setting__hint">
          {relogin
            ? "Your session expired. Log in again to keep syncing."
            : "Optional end-to-end-encrypted sync of your tasks, notes, and settings across devices."}
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
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run(sync.login);
          }}
        />
        {sync.lastError && <span className="account__error">{sync.lastError}</span>}
        <div className="account__row">
          {!relogin && (
            <button
              className="account__btn"
              onClick={() => void run(sync.signup)}
              disabled={busy || !email.trim() || !password}
            >
              Create account
            </button>
          )}
          <button
            className="account__btn account__btn--primary"
            onClick={() => void run(sync.login)}
            disabled={busy || !email.trim() || !password}
          >
            {busy ? "…" : "Log in"}
          </button>
        </div>
      </div>
    );
  }

  // Signed in
  const statusText =
    sync.status === "syncing"
      ? "Syncing…"
      : sync.status === "error"
        ? sync.lastError ?? "Sync error"
        : sync.lastSyncedAt
          ? `Synced ${relativeTime(sync.lastSyncedAt)}`
          : "Synced";

  return (
    <div className="setting setting--col account">
      <span className="setting__label">Cloud sync</span>
      <span className="account__email">{sync.email}</span>
      <span className={`account__status${sync.status === "error" ? " account__status--error" : ""}`}>
        {statusText}
      </span>
      {sync.hadNotesConflict && (
        <span className="setting__hint">
          A conflicting notes edit was saved as a backup copy on the server.
        </span>
      )}
      <div className="account__row">
        <button
          className="account__btn"
          onClick={() => sync.syncNow()}
          disabled={sync.status === "syncing"}
        >
          Sync now
        </button>
        <button className="account__btn" onClick={() => void sync.logout()}>
          Log out
        </button>
      </div>
    </div>
  );
}
