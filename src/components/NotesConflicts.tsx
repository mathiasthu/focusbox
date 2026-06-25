import { useEffect, useState } from "react";
import type { SyncController } from "../hooks/useSync";
import { notesPlainText, type ConflictMeta } from "../lib/conflicts";

export default function NotesConflicts({ sync }: { sync: SyncController }) {
  const [items, setItems] = useState<ConflictMeta[] | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function refresh() {
    try {
      setItems(await sync.listConflicts());
    } catch {
      setItems([]);
    }
    setConfirmKey(null);
  }

  // load the list once when signed in
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // lazily fetch previews when expanded
  useEffect(() => {
    if (!expanded || !items) return;
    for (const it of items) {
      if (previews[it.key] !== undefined) continue;
      void sync
        .getConflict(it.key)
        .then((c) => setPreviews((p) => ({ ...p, [it.key]: notesPlainText(c.doc) || "(empty)" })))
        .catch(() => setPreviews((p) => ({ ...p, [it.key]: "(unreadable)" })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, items]);

  if (!items || items.length === 0) return null;

  async function restore(key: string) {
    setBusyKey(key);
    try {
      await sync.restoreConflict(key);
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }
  async function discard(key: string) {
    setBusyKey(key);
    try {
      await sync.discardConflict(key);
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="account__conflicts">
      <button className="account__link" onClick={() => setExpanded((v) => !v)}>
        Notes backups ({items.length}) {expanded ? "▾" : "▸"}
      </button>
      {expanded && (
        <ul className="account__conflicts-list">
          {items.map((it) => (
            <li key={it.key} className="account__conflict">
              <span className="account__conflict-meta">{new Date(it.updatedAt).toLocaleString()}</span>
              <span className="account__conflict-preview">{previews[it.key] ?? "…"}</span>
              <div className="account__row">
                {confirmKey === it.key ? (
                  <button
                    className="account__btn account__btn--primary"
                    disabled={busyKey === it.key}
                    onClick={() => void restore(it.key)}
                  >
                    Replace current note
                  </button>
                ) : (
                  <button
                    className="account__btn"
                    disabled={busyKey === it.key}
                    onClick={() => setConfirmKey(it.key)}
                  >
                    Restore
                  </button>
                )}
                <button
                  className="account__btn"
                  disabled={busyKey === it.key}
                  onClick={() => void discard(it.key)}
                >
                  Discard
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
