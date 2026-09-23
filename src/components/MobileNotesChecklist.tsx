import { useState, type FormEvent } from "react";
import type { NotesDoc } from "../lib/store";
import { appendNoteItem, noteChecklistItems, setNoteItemDone } from "../lib/mobileNotes";

interface Props {
  doc: NotesDoc;
  onChange: (doc: NotesDoc) => void;
  onOpenSettings: () => void;
}

export default function MobileNotesChecklist({ doc, onChange, onOpenSettings }: Props) {
  const [draft, setDraft] = useState("");
  const items = noteChecklistItems(doc);
  const remaining = items.filter((item) => !item.done).length;

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    onChange(appendNoteItem(doc, draft));
    setDraft("");
  }

  return (
    <div className="mobile-notes">
      <header className="mobile-notes__header">
        <div>
          <span className="mobile-notes__brand">focusbox</span>
          <h1>Checklist</h1>
        </div>
        <button type="button" className="mobile-notes__settings" onClick={onOpenSettings}>
          Settings
        </button>
      </header>

      <div className="mobile-notes__body">
        <p className="mobile-notes__count" aria-live="polite">
          {items.length === 0 ? "Your notes list" : `${remaining} remaining`}
        </p>
        {items.length === 0 ? (
          <p className="mobile-notes__empty">No list items in Notes yet.</p>
        ) : (
          <ul className="mobile-notes__list">
            {items.map((item) => (
              <li key={item.path.join("-")} className="mobile-notes__item">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={item.done}
                  className={`mobile-notes__toggle${item.done ? " mobile-notes__toggle--done" : ""}`}
                  onClick={() => onChange(setNoteItemDone(doc, item.path, !item.done))}
                  style={{ paddingLeft: `${16 + Math.min(item.depth, 3) * 16}px` }}
                >
                  <span className="mobile-notes__box" aria-hidden="true" />
                  <span className="mobile-notes__text">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form className="mobile-notes__composer" onSubmit={addItem}>
        <label className="mobile-notes__label" htmlFor="mobile-note-input">New note item</label>
        <input
          id="mobile-note-input"
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add to Notes"
          enterKeyHint="done"
        />
        <button type="submit" disabled={!draft.trim()}>Add</button>
      </form>
    </div>
  );
}
