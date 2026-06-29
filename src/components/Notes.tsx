import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NotesDoc } from "../lib/store";
import { returnItemToNotes, type FocusItem, type Node as PMNode } from "../lib/focusReturn";

/** What a hovered notepad line carries when promoted to the focus card. */
export interface PromotePayload {
  text: string;
  path: number[];
  node: PMNode;
}

/** Imperative API App uses to push a focus item back into the notes (the return). */
export interface NotesHandle {
  returnToNotes: (item: FocusItem) => void;
}

interface Props {
  doc: NotesDoc;
  onChange: (doc: NotesDoc) => void;
  onPromote: (p: PromotePayload) => void;
}

const LIST_TYPES = new Set(["taskList", "bulletList", "orderedList"]);

function Btn({
  active,
  onClick,
  label,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`tool${active ? " tool--active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  // In TipTap v3, useEditor does not re-render on every transaction. Derive the
  // active states reactively so highlights track the cursor (and clear when it
  // leaves formatted text) instead of getting stuck "on" after a command.
  const active = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            h1: editor.isActive("heading", { level: 1 }),
            h2: editor.isActive("heading", { level: 2 }),
            bold: editor.isActive("bold"),
            italic: editor.isActive("italic"),
            strike: editor.isActive("strike"),
            bullet: editor.isActive("bulletList"),
            ordered: editor.isActive("orderedList"),
            task: editor.isActive("taskList"),
          }
        : null,
  });

  if (!editor || !active) return <div className="toolbar" />;
  const chain = () => editor.chain().focus();
  return (
    <div className="toolbar">
      <Btn label="Heading 1" active={active.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()}>
        <span className="tool__txt">H1</span>
      </Btn>
      <Btn label="Heading 2" active={active.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <span className="tool__txt">H2</span>
      </Btn>

      <span className="toolbar__sep" />

      <Btn label="Bold" active={active.bold} onClick={() => chain().toggleBold().run()}>
        <span className="tool__txt" style={{ fontWeight: 700 }}>B</span>
      </Btn>
      <Btn label="Italic" active={active.italic} onClick={() => chain().toggleItalic().run()}>
        <span className="tool__txt" style={{ fontStyle: "italic", fontFamily: "Fraunces, serif" }}>I</span>
      </Btn>
      <Btn label="Strikethrough" active={active.strike} onClick={() => chain().toggleStrike().run()}>
        <span className="tool__txt" style={{ textDecoration: "line-through" }}>S</span>
      </Btn>

      <span className="toolbar__sep" />

      <Btn label="Bullet list" active={active.bullet} onClick={() => chain().toggleBulletList().run()}>
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="3" cy="4.5" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="3" cy="9" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="3" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
          <path d="M7 4.5h8M7 9h8M7 13.5h8" />
        </svg>
      </Btn>
      <Btn label="Numbered list" active={active.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 4.5h7M8 9h7M8 13.5h7" />
          <path d="M2 3.2h1.2v3M1.7 13.9h1.6M1.7 11.6c0-.6 1.5-.6 1.5.2 0 .5-1.5 1-1.5 2.1" stroke="currentColor" />
        </svg>
      </Btn>
      <Btn label="Checklist" active={active.task} onClick={() => chain().toggleTaskList().run()}>
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1.5" y="2" width="6" height="6" rx="1.4" />
          <path d="M2.8 5l1.3 1.3 2-2.4" />
          <path d="M10.5 5h5.5M10.5 12.5h5.5" />
          <rect x="1.5" y="9.5" width="6" height="6" rx="1.4" />
        </svg>
      </Btn>
    </div>
  );
}

const Notes = forwardRef<NotesHandle, Props>(function Notes({ doc, onChange, onPromote }, ref) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder:
          "Start writing…  Use the bar above, or type “# ”, “- ”, “[ ] ” for instant formatting.",
      }),
    ],
    content: doc ?? "",
    onUpdate: ({ editor }) => onChange(editor.getJSON() as NotesDoc),
  });

  // Floating "focus this line" button position (relative to the .notes section),
  // and the line element it currently targets.
  const [promoteAt, setPromoteAt] = useState<{ top: number; left: number } | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const lineElRef = useRef<HTMLElement | null>(null);
  // The button sits in the gutter, slightly left of its line, so moving the pointer
  // toward it briefly crosses non-line space. Clear on a short delay (cancelled if the
  // pointer reaches the line or the button) so the button doesn't vanish in transit.
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply an EXTERNAL doc change (e.g. notes pulled from another device by cloud
  // sync) into the editor. Skip while the editor is focused so we never clobber
  // what the user is actively typing — their version is the source of truth then,
  // and LWW/conflict-copy handles the divergence. emitUpdate:false avoids a feedback
  // loop back through onUpdate.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const incoming = doc == null ? null : JSON.stringify(doc);
    const current = editor.isEmpty ? null : JSON.stringify(editor.getJSON());
    if (incoming === current) return;
    editor.commands.setContent(doc ?? "", { emitUpdate: false });
    clearPromote(); // the hovered line's DOM node may have just been replaced
  }, [doc, editor]);

  // The button holds absolute coords; a resize re-lays-out the editor. Clear it (and
  // any pending timer) on resize and on unmount.
  useEffect(() => {
    const onResize = () => clearPromote();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelPendingClear();
    };
  }, []);

  // Return a focus item to the notes by re-inserting it into the LIVE editor doc
  // (source of truth — avoids racing App's notesDoc state). No-op for dragged
  // (origin-null) items, which never left the notes. emitUpdate:true so the change
  // flows back through onChange → persistence + sync.
  useImperativeHandle(
    ref,
    () => ({
      returnToNotes(item: FocusItem) {
        if (!editor || !item.origin) return;
        const next = returnItemToNotes(editor.getJSON() as Record<string, unknown>, item);
        editor.commands.setContent(next as Record<string, unknown>, { emitUpdate: true });
      },
    }),
    [editor],
  );

  // The promotable "line" under a point: the nearest list item, else the nearest
  // top-level block of the editor. Null when outside the editor.
  function lineElFor(target: HTMLElement): HTMLElement | null {
    if (!editor) return null;
    const root = editor.view.dom as HTMLElement;
    if (!root.contains(target)) return null;
    const li = target.closest("li");
    if (li && root.contains(li)) return li as HTMLElement;
    let el: HTMLElement | null = target;
    while (el && el.parentElement !== root) el = el.parentElement;
    if (!el || el === root) return null;
    // Don't promote a whole list when the pointer is over its bare padding/gutter.
    if (el.tagName === "UL" || el.tagName === "OL") return null;
    return el;
  }

  function cancelPendingClear() {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  }

  function clearPromote() {
    cancelPendingClear();
    setPromoteAt(null);
    lineElRef.current = null;
  }

  // Clear after a short grace period so moving the pointer line → button (across the
  // gutter gap) doesn't dismiss the button mid-transit.
  function scheduleClear() {
    cancelPendingClear();
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setPromoteAt(null);
      lineElRef.current = null;
    }, 160);
  }

  function refreshPromote(target: HTMLElement) {
    if (!editor) return;
    if (target.closest(".note-promote")) {
      cancelPendingClear(); // hovering the button itself — keep it
      return;
    }
    const el = lineElFor(target);
    const host = hostRef.current;
    if (!el || !host || !el.textContent || !el.textContent.trim()) {
      scheduleClear();
      return;
    }
    cancelPendingClear();
    const r = el.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    let left = r.left - hr.left - 30; // sit in the left gutter, just before the line
    if (left < 4) left = 4;
    lineElRef.current = el;
    setPromoteAt({ top: r.top - hr.top + r.height / 2, left });
  }

  // Resolve the hovered line to {text, path, node, range} via ProseMirror, remove it
  // from the doc, and hand it up to become the focus item.
  function doPromote() {
    const el = lineElRef.current;
    if (!el || !editor) return;
    const view = editor.view;
    let payload: PromotePayload | null = null;
    let range: { from: number; to: number } | null = null;
    try {
      const pos = view.posAtDOM(el, 0);
      const $pos = view.state.doc.resolve(pos);

      // A TOP-LEVEL list item: the depth-2 node whose parent (depth 1) is a list.
      // Hovering a nested item resolves to depth>2; we still match its top-level
      // ancestor item here, so the whole item (incl. its sub-list) round-trips
      // verbatim instead of producing a misplaced/invalid fragment.
      if ($pos.depth >= 2) {
        const item = $pos.node(2);
        const list = $pos.node(1);
        if (
          (item.type.name === "taskItem" || item.type.name === "listItem") &&
          LIST_TYPES.has(list.type.name)
        ) {
          const onlyChild = list.childCount === 1;
          range = onlyChild
            ? { from: $pos.before(1), to: $pos.after(1) }
            : { from: $pos.before(2), to: $pos.after(2) };
          payload = {
            text: item.textContent,
            path: [$pos.index(0), $pos.index(1)],
            node: item.toJSON() as PMNode,
          };
        }
      }

      // Otherwise the top-level block (paragraph/heading/blockquote/…).
      if (!payload) {
        const block = $pos.node(1);
        range = { from: $pos.before(1), to: $pos.after(1) };
        payload = {
          text: block.textContent,
          path: [$pos.index(0)],
          node: block.toJSON() as PMNode,
        };
      }
    } catch {
      clearPromote(); // detached/replaced line (e.g. after an external sync) — bail
      return;
    }

    if (!payload || !range || !payload.text.trim()) {
      clearPromote();
      return;
    }
    editor.chain().deleteRange(range).run();
    clearPromote();
    onPromote(payload);
  }

  return (
    <section
      className="notes"
      ref={(el) => {
        hostRef.current = el;
      }}
      onMouseMove={(e) => refreshPromote(e.target as HTMLElement)}
      onMouseLeave={clearPromote}
    >
      <Toolbar editor={editor} />
      <div className="notes__scroll" onScroll={clearPromote}>
        <EditorContent editor={editor} className="notes__editor" />
      </div>
      {promoteAt && (
        <button
          type="button"
          className="note-promote"
          style={{ top: promoteAt.top, left: promoteAt.left }}
          aria-label="Move this line under the timer"
          title="Focus on this line"
          onMouseDown={(e) => e.preventDefault()}
          onClick={doPromote}
        >
          <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 3v8" />
            <path d="M5.5 7.5 9 11l3.5-3.5" />
            <path d="M4 14.5h10" />
          </svg>
        </button>
      )}
    </section>
  );
});

export default Notes;
