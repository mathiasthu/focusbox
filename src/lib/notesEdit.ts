import type { NotesDoc } from "./store";

// A single ProseMirror/TipTap node in the notes doc JSON.
type Node = { type?: string; content?: Node[]; [k: string]: unknown };

function isEmptyParagraph(n: Node): boolean {
  return n?.type === "paragraph" && (!Array.isArray(n.content) || n.content.length === 0);
}

/**
 * Append each text line as its own paragraph at the end of the notes doc.
 *
 * Used by the timer-reset flow (unmarked left tasks return to the notepad, one
 * line each). Pure + JSON-only so it's unit-testable without TipTap/DOM.
 *
 * - Blank/whitespace-only lines are dropped; empty input returns the doc unchanged.
 * - A null/empty/malformed doc becomes a fresh doc holding just the new lines.
 * - Trailing empty paragraphs are trimmed first so lines don't accumulate blank
 *   gaps on repeated appends (TipTap commonly keeps a trailing empty paragraph).
 */
export function appendTaskLines(doc: NotesDoc, lines: string[]): NotesDoc {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  if (clean.length === 0) return doc;

  const paras: Node[] = clean.map((text) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  }));

  const d = doc as Node | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.content)) {
    return { type: "doc", content: paras } as NotesDoc;
  }

  const content = d.content.slice();
  while (content.length > 0 && isEmptyParagraph(content[content.length - 1])) {
    content.pop();
  }
  return { ...d, type: d.type ?? "doc", content: [...content, ...paras] } as NotesDoc;
}
