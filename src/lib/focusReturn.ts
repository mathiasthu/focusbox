// Pure, JSON-only logic for the "active task under the clock" return flow. No
// TipTap/DOM here so it's fully unit-testable (mirrors notesEdit.ts). The notes
// document is plain ProseMirror/TipTap JSON.

// A single ProseMirror/TipTap node.
export type Node = {
  type?: string;
  content?: Node[];
  attrs?: Record<string, unknown>;
  [k: string]: unknown;
};
// The notes document JSON (shape varies); null until the user has typed anything.
export type Doc = Record<string, unknown> | null;

/** Where a promoted line came from, so it can be returned to that spot. */
export interface FocusOrigin {
  // Child-index path from the doc root to the promoted node:
  //   [i]    → top-level block i
  //   [i, j] → item j of the list at top-level index i
  path: number[];
  node: Node; // the exact removed node JSON, for a verbatim (not-done) return
}

/** The single active task pinned under the clock. Persisted locally, never synced. */
export interface FocusItem {
  text: string;
  done: boolean;
  origin: FocusOrigin | null; // null for drag-copied items (nothing to return)
}

const LIST_TYPES = new Set(["taskList", "bulletList", "orderedList"]);

function asDoc(doc: Doc): Node | null {
  return doc && typeof doc === "object" ? (doc as Node) : null;
}

/** Build a checked checklist line (a one-item taskList) carrying `text`. */
export function checkedLine(text: string): Node {
  return {
    type: "taskList",
    content: [
      {
        type: "taskItem",
        attrs: { checked: true },
        content: [
          { type: "paragraph", content: text ? [{ type: "text", text }] : [] },
        ],
      },
    ],
  };
}

// Wrap a bare list item in a minimal list so it stays a valid top-level block.
function wrapForTopLevel(node: Node): Node {
  if (node.type === "taskItem") return { type: "taskList", content: [node] };
  if (node.type === "listItem") return { type: "bulletList", content: [node] };
  return node;
}

function clamp(i: number, max: number): number {
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.min(Math.floor(i), max);
}

/**
 * Insert `node` into the notes doc at `path`, returning a NEW doc (no mutation).
 *
 * - `[i]`   → into the top-level content at index i (clamped to [0, len]).
 * - `[i, j]`→ into the list at top-level index i, at item index j (clamped). If
 *   there is no list there (it was edited/removed), fall back to inserting the
 *   node (wrapped if it's a bare list item) at top-level index i.
 * - A null/contentless doc becomes a fresh `{type:'doc', content:[node]}`.
 */
export function insertNodeAtPath(doc: Doc, path: number[], node: Node): Doc {
  const d = asDoc(doc);
  if (!d || !Array.isArray(d.content)) {
    return { type: "doc", content: [path.length >= 2 ? wrapForTopLevel(node) : node] } as Doc;
  }

  const top = clamp(path[0] ?? 0, d.content.length);

  if (path.length >= 2) {
    const list = d.content[top];
    if (list && typeof list === "object" && LIST_TYPES.has(list.type ?? "") && Array.isArray(list.content)) {
      const j = clamp(path[1] ?? 0, list.content.length);
      const items = list.content.slice();
      items.splice(j, 0, node);
      const content = d.content.slice();
      content[top] = { ...list, content: items };
      return { ...d, type: d.type ?? "doc", content } as Doc;
    }
    // List gone → degrade to a top-level insert of a valid block.
    const content = d.content.slice();
    content.splice(top, 0, wrapForTopLevel(node));
    return { ...d, type: d.type ?? "doc", content } as Doc;
  }

  const content = d.content.slice();
  content.splice(top, 0, node);
  return { ...d, type: d.type ?? "doc", content } as Doc;
}

/**
 * Return a focus item to the notes doc (new doc; no mutation):
 *  - dragged copy (origin null) → doc unchanged (it never left the notes).
 *  - done   → a checked checklist line at the original top-level index.
 *  - not done → the original node verbatim at its recorded path.
 */
export function returnItemToNotes(doc: Doc, item: FocusItem): Doc {
  const { origin } = item;
  if (!origin) return doc;
  if (item.done) {
    return insertNodeAtPath(doc, [origin.path[0] ?? 0], checkedLine(item.text));
  }
  return insertNodeAtPath(doc, origin.path, origin.node);
}
