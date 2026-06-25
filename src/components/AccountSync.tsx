import { useState } from "react";
import type { SyncController } from "../hooks/useSync";
import RecoverForm from "./RecoverForm";
import NotesConflicts from "./NotesConflicts";

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

function formatDate(ms: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "";
  }
}

/** Defense-in-depth: only ever open a URL whose host is a Stripe domain. The Tauri opener
 * capability already scopes to https://*.stripe.com/*, but the dev/browser path
 * (window.open) has no such guard, so validate against a compromised API response. */
function isStripeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com"));
  } catch {
    return false;
  }
}

// Opens a Stripe Checkout / Portal URL in the user's browser (Tauri opener, or a new
// tab in the dev preview).
async function openExternal(url: string) {
  if (!isStripeUrl(url)) {
    console.error("Focusbox: refusing to open a non-Stripe billing URL.", url);
    return;
  }
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
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
  const [billingBusy, setBillingBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);

  async function startTrial(plan: "monthly" | "annual") {
    if (billingBusy) return;
    setBillingBusy(true);
    try {
      await openExternal(await sync.startCheckout(plan));
    } catch (e) {
      console.error("Focusbox: couldn't start checkout.", e);
    } finally {
      setBillingBusy(false);
    }
  }

  async function manageSubscription() {
    if (billingBusy) return;
    setBillingBusy(true);
    try {
      await openExternal(await sync.openPortal());
    } catch (e) {
      console.error("Focusbox: couldn't open the billing portal.", e);
    } finally {
      setBillingBusy(false);
    }
  }

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
    if (recovering) {
      return <RecoverForm sync={sync} onBack={() => setRecovering(false)} />;
    }
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
        {!relogin && (
          <button className="account__link" onClick={() => setRecovering(true)}>
            Forgot password?
          </button>
        )}
      </div>
    );
  }

  // Signed in
  const statusText =
    sync.status === "syncing"
      ? "Syncing…"
      : sync.status === "paused"
        ? "Sync paused"
        : sync.status === "error"
          ? sync.lastError ?? "Sync error"
          : sync.lastSyncedAt
            ? `Synced ${relativeTime(sync.lastSyncedAt)}`
            : "Synced";
  const statusBad = sync.status === "error" || sync.status === "paused";

  return (
    <div className="setting setting--col account">
      <span className="setting__label">Cloud sync</span>
      <span className="account__email">{sync.email}</span>
      <span className={`account__status${statusBad ? " account__status--error" : ""}`}>
        {statusText}
      </span>
      <NotesConflicts sync={sync} />

      {sync.billingEnabled &&
        (sync.syncEnabled ? (
          <div className="account__billing">
            <span className="setting__hint">
              {sync.subscriptionStatus === "trialing" ? "Free trial" : "Subscribed"}
              {sync.currentPeriodEnd ? ` — renews ${formatDate(sync.currentPeriodEnd)}` : ""}
            </span>
            <button className="account__btn" onClick={() => void manageSubscription()} disabled={billingBusy}>
              Manage subscription
            </button>
          </div>
        ) : sync.subscriptionStatus === "past_due" ? (
          <div className="account__billing">
            <span className="account__error">
              Payment failed — sync is paused. Update your card to resume.
            </span>
            <button
              className="account__btn account__btn--primary"
              onClick={() => void manageSubscription()}
              disabled={billingBusy}
            >
              Update payment
            </button>
          </div>
        ) : (
          <div className="account__billing">
            <span className="setting__hint">
              Start your 14-day free trial to sync across devices. Cancel anytime.
            </span>
            <div className="account__row">
              <button
                className="account__btn account__btn--primary"
                onClick={() => void startTrial("monthly")}
                disabled={billingBusy}
              >
                Monthly
              </button>
              <button className="account__btn" onClick={() => void startTrial("annual")} disabled={billingBusy}>
                Annual
              </button>
            </div>
          </div>
        ))}

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
