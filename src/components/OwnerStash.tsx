import { useState } from "react";
import type { SyncController } from "../hooks/useSync";

function formatWhen(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

/**
 * Tasks and notes belonging to accounts that previously used this install.
 *
 * Without this the data was invisible. Signing out leaves tasks and notes in the app on
 * purpose, so at the next sign-in they may belong to someone else — the app sets them
 * aside rather than pushing them into the new account's cloud blobs. That part was right;
 * what was missing was any way to see or get them back. The sequence "delete account →
 * create a new one" hit it hardest: `logout()` leaves the ownership marker pointing at the
 * deleted account, so the new account is a mismatch, the user's own data is set aside, and
 * the app hands back an empty state — while the delete dialog had just promised "your
 * tasks and notes stay on this device". True at that moment, silently untrue one step
 * later, with no route back short of hand-editing focusbox.json (and four more account
 * switches would evict it for good).
 */
export default function OwnerStash({ sync }: { sync: SyncController }) {
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(sync.dataSetAsideThisSession);

  if (sync.stashedOwners.length === 0) return null;

  async function run(tag: string, fn: (t: string) => Promise<void>) {
    setBusyTag(tag);
    try {
      await fn(tag);
    } finally {
      setBusyTag(null);
      setConfirmDiscard(null);
    }
  }

  return (
    <div className="account__stash">
      {sync.dataSetAsideThisSession && (
        <span className="setting__hint account__stash-notice">
          {sync.dataSetAsideReason === "unknown"
            ? // Don't claim the data belongs to someone else here — we genuinely don't know,
              // and the likeliest person reading this is someone who used Focusbox locally
              // for a long time and has only just made their first account.
              "This device already had tasks and notes, and Focusbox couldn't tell which account they belonged to. Nothing was deleted — they've been set aside rather than added to this account. If they're yours, restore them below."
            : "The tasks and notes that were here belong to a different account, so they've been set aside on this device — nothing was deleted. Restore them below if they're yours."}
        </span>
      )}
      <button className="account__link" onClick={() => setExpanded((v) => !v)}>
        Data from other accounts on this device ({sync.stashedOwners.length}) {expanded ? "▾" : "▸"}
      </button>
      {expanded && (
        <ul className="account__stash-list">
          {sync.stashedOwners.map((s) => (
            <li key={s.tag} className="account__stash-item">
              <span className="account__stash-meta">
                {s.taskCount} {s.taskCount === 1 ? "task" : "tasks"}
                {s.savedAt ? ` · set aside ${formatWhen(s.savedAt)}` : ""}
              </span>
              <span className="account__stash-preview">{s.notePreview || "(no notes)"}</span>
              <div className="account__row">
                <button
                  className="account__btn"
                  disabled={busyTag !== null}
                  onClick={() => void run(s.tag, sync.restoreStash)}
                >
                  Restore
                </button>
                {confirmDiscard === s.tag ? (
                  <button
                    className="account__btn account__btn--danger"
                    disabled={busyTag !== null}
                    onClick={() => void run(s.tag, sync.discardStash)}
                  >
                    Delete permanently
                  </button>
                ) : (
                  <button
                    className="account__btn"
                    disabled={busyTag !== null}
                    onClick={() => setConfirmDiscard(s.tag)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {expanded && (
        <span className="setting__hint">
          Restoring swaps this data into the app. If you're signed in, it becomes part of
          that account and will sync — whatever is on screen now is set aside in its place,
          so you can swap back.
        </span>
      )}
    </div>
  );
}
