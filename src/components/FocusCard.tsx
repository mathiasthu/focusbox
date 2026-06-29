import { useState } from "react";
import type { FocusItem } from "../lib/focusReturn";

interface Props {
  item: FocusItem | null;
  dragging: boolean;
  onToggleDone: (done: boolean) => void;
  onEject: () => void;
  onDropText: (text: string) => void;
}

/**
 * The "focus card" pinned under the clock. Holds at most one active task:
 *  - occupied → greyish card with a done checkbox, the text, and a hover eject ✕.
 *  - empty    → renders nothing, EXCEPT while a drag is in progress, when it shows a
 *    drop zone so a notepad selection can be dragged in to start one (kept minimal:
 *    no permanent empty box under the clock).
 * The whole slot is a drop target for selected text (copy — see App.dragSetFocus).
 */
export default function FocusCard({ item, dragging, onToggleDone, onEject, onDropText }: Props) {
  const [over, setOver] = useState(false);

  const dnd = {
    onDragOver: (e: React.DragEvent) => {
      // Only accept drags carrying text.
      if (!e.dataTransfer.types.includes("text/plain")) return;
      e.preventDefault();
      // Force COPY (J1): ProseMirror starts a no-modifier drag as a MOVE, which would
      // make WebKit delete the dragged text from the notepad. Negotiating "copy" here
      // leaves the source untouched.
      e.dataTransfer.dropEffect = "copy";
      if (!over) setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Ignore leaves into a child element.
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const text = e.dataTransfer.getData("text/plain").trim();
      if (text) onDropText(text);
    },
  };

  if (!item) {
    if (!dragging) return null; // no permanent empty box — only a target mid-drag
    return (
      <div className={`focus-slot focus-slot--empty${over ? " focus-slot--over" : ""}`} {...dnd}>
        <span className="focus-slot__hint">Drop text here to focus on it</span>
      </div>
    );
  }

  return (
    <section
      className={`focus-slot focus-card${item.done ? " focus-card--done" : ""}${over ? " focus-slot--over" : ""}`}
      aria-label="Focus task"
      {...dnd}
    >
      <input
        type="checkbox"
        className="focus-card__check"
        checked={item.done}
        onChange={(e) => onToggleDone(e.target.checked)}
        aria-label={item.done ? "Mark focus task not done" : "Mark focus task done"}
      />
      <span className="focus-card__text">{item.text}</span>
      <button
        type="button"
        className="focus-card__eject"
        onClick={onEject}
        aria-label="Return task to notes"
        title="Return to notes"
      >
        ×
      </button>
    </section>
  );
}
