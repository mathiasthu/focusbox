import type { NotesDoc } from "./store";

type NoteNode = {
  type: string;
  content?: NoteNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; [key: string]: unknown }[];
  text?: string;
  [key: string]: unknown;
};

export interface NoteChecklistItem {
  path: number[];
  text: string;
  done: boolean;
  depth: number;
}

function ownTextNodes(item: NoteNode): NoteNode[] {
  const visit = (node: NoteNode): NoteNode[] =>
    node.type === "text" ? [node] : (node.content ?? []).flatMap(visit);
  return (item.content ?? [])
    .filter((node) => node.type !== "bulletList" && node.type !== "orderedList" && node.type !== "taskList")
    .flatMap(visit);
}

function isList(type: string): boolean {
  return type === "bulletList" || type === "orderedList" || type === "taskList";
}

/** Only actual Notes list items appear on the phone; headings and prose stay untouched. */
export function noteChecklistItems(doc: NotesDoc): NoteChecklistItem[] {
  const items: NoteChecklistItem[] = [];
  const walk = (node: NoteNode, path: number[], depth: number) => {
    if (node.type === "listItem" || node.type === "taskItem") {
      const texts = ownTextNodes(node);
      const text = texts.map((part) => part.text ?? "").join("").trim();
      if (text) {
        items.push({
          path,
          text,
          done: node.type === "taskItem"
            ? node.attrs?.checked === true
            : texts.length > 0 && texts.every((part) => part.marks?.some((mark) => mark.type === "strike")),
          depth,
        });
      }
    }
    node.content?.forEach((child, index) => {
      if (isList(node.type) || isList(child.type)) {
        walk(child, [...path, index], isList(child.type) && path.length > 0 ? depth + 1 : depth);
      }
    });
  };
  if (doc && doc.type === "doc") walk(doc as NoteNode, [], 0);
  return items;
}

function changeOwnText(node: NoteNode, done: boolean): NoteNode {
  if (node.type === "text") {
    const marks = (node.marks ?? []).filter((mark) => mark.type !== "strike");
    if (done) marks.push({ type: "strike" });
    const next = { ...node };
    if (marks.length) next.marks = marks;
    else delete next.marks;
    return next;
  }
  return node.content ? { ...node, content: node.content.map((child) => changeOwnText(child, done)) } : node;
}

/** Toggle a single list item in the existing TipTap JSON without altering neighboring content. */
export function setNoteItemDone(doc: NotesDoc, path: number[], done: boolean): NotesDoc {
  if (!doc || doc.type !== "doc" || path.length < 2) return doc;
  const root = doc as NoteNode;
  let node = root;
  for (const index of path) {
    if (!Number.isInteger(index) || index < 0 || !node.content?.[index]) return doc;
    node = node.content[index];
  }
  if (node.type !== "listItem" && node.type !== "taskItem") return doc;
  if (!ownTextNodes(node).length) return doc;

  let changed: NoteNode;
  if (node.type === "taskItem") {
    changed = { ...node, attrs: { ...node.attrs, checked: done } };
  } else {
    changed = {
      ...node,
      content: node.content?.map((child) => isList(child.type) ? child : changeOwnText(child, done)),
    };
  }
  const replace = (parent: NoteNode, level: number): NoteNode => ({
    ...parent,
    content: parent.content?.map((child, index) =>
      index === path[level] ? (level === path.length - 1 ? changed : replace(child, level + 1)) : child,
    ),
  });
  return replace(root, 0) as NotesDoc;
}

/** Add a bullet to Notes, reusing the trailing bullet list when possible. */
export function appendNoteItem(doc: NotesDoc, value: string): NotesDoc {
  const text = value.trim();
  if (!text) return doc;
  const item: NoteNode = {
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
  const root = doc?.type === "doc" && Array.isArray(doc.content)
    ? doc as NoteNode
    : { type: "doc", content: [] as NoteNode[] };
  const content = [...(root.content ?? [])];
  while (content.length && content[content.length - 1].type === "paragraph"
    && !content[content.length - 1].content?.length) content.pop();
  const last = content[content.length - 1];
  if (last?.type === "bulletList") {
    content[content.length - 1] = { ...last, content: [...(last.content ?? []), item] };
  } else {
    content.push({ type: "bulletList", content: [item] });
  }
  return { ...root, content } as NotesDoc;
}
