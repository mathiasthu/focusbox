// Pure JSON transforms for the "focus task under the timer" feature.
// The notes doc is the single source of truth: exactly one listItem/taskItem
// may carry `attrs.focused: true`. These helpers never mutate their input.
import type { NotesDoc } from "./store";

type Node = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
  marks?: { type: string }[];
};

export interface FocusedTask {
  text: string;
  done: boolean;
}

const FOCUSABLE = new Set(["listItem", "taskItem"]);

function isFocused(n: Node): boolean {
  return FOCUSABLE.has(n.type ?? "") && n.attrs?.focused === true;
}

function findFocused(n: Node): Node | null {
  if (isFocused(n)) return n;
  for (const child of n.content ?? []) {
    const hit = findFocused(child);
    if (hit) return hit;
  }
  return null;
}

function textNodes(n: Node): Node[] {
  if (n.type === "text") return [n];
  return (n.content ?? []).flatMap(textNodes);
}

/** The current focus task derived from the doc, or null if none. */
export function getFocusedTask(doc: NotesDoc): FocusedTask | null {
  if (!doc) return null;
  const node = findFocused(doc as Node);
  if (!node) return null;
  const texts = textNodes(node);
  const done =
    node.type === "taskItem"
      ? node.attrs?.checked === true
      : texts.length > 0 &&
        texts.every((t) => (t.marks ?? []).some((m) => m.type === "strike"));
  return { text: texts.map((t) => t.text ?? "").join(""), done };
}

function mapNodes(n: Node, fn: (n: Node) => Node): Node {
  const mapped = fn(n);
  if (!mapped.content) return mapped;
  const content = mapped.content.map((c) => mapNodes(c, fn));
  return content.every((c, i) => c === mapped.content![i]) && mapped === n
    ? n
    : { ...mapped, content };
}

/** Remove the focused flag everywhere. Returns the input doc when nothing changed. */
export function clearFocused(doc: NotesDoc): NotesDoc {
  if (!doc || !findFocused(doc as Node)) return doc;
  return mapNodes(doc as Node, (n) =>
    isFocused(n) ? { ...n, attrs: { ...n.attrs, focused: false } } : n,
  ) as NotesDoc;
}

/**
 * Mark the focused line done IN the doc: check a taskItem, or strike all text
 * of a bullet listItem. Keeps the focused attr (the card persists until timer
 * reset; CSS suppresses the highlight once the line reads as done).
 */
export function markFocusedDone(doc: NotesDoc): NotesDoc {
  if (!doc) return doc;
  const target = findFocused(doc as Node);
  if (!target) return doc;
  return mapNodes(doc as Node, (n) => {
    if (n !== target) return n;
    if (n.type === "taskItem") return { ...n, attrs: { ...n.attrs, checked: true } };
    // bullet listItem: add strike to every text node (keep existing marks)
    const strike = (child: Node): Node => {
      if (child.type === "text") {
        const marks = child.marks ?? [];
        if (marks.some((m) => m.type === "strike")) return child;
        return { ...child, marks: [...marks, { type: "strike" }] };
      }
      if (!child.content) return child;
      return { ...child, content: child.content.map(strike) };
    };
    return strike(n);
  }) as NotesDoc;
}
