import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NotesDoc } from "../lib/store";
import { FocusedLine } from "../lib/focusedLineExtension";

interface Props {
  doc: NotesDoc;
  onChange: (doc: NotesDoc) => void;
  onAddTasks: (lines: string[]) => void;
  onEditorReady: (editor: Editor | null) => void;
  onLineDragChange: (dragging: boolean) => void;
  showTasks: boolean;
  focusDone: boolean;
}

function Btn({
  active,
  onClick,
  label,
  children,
  disabled,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tool${active ? " tool--active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Compact dropdown grouping for the toolbar: a trigger button (highlighted when
// any contained item is active) that reveals an absolutely-positioned panel of
// items on click. Closes on outside click / Escape. Trigger + items use
// onMouseDown preventDefault so the editor selection survives, matching Btn.
function MenuBar({
  label,
  trigger,
  active,
  open,
  onToggle,
  onClose,
  children,
}: {
  label: string;
  trigger: ReactNode;
  active?: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  return (
    <div className="tool-menu" ref={ref}>
      <button
        type="button"
        className={`tool tool-menu__trigger${active ? " tool--active" : ""}${open ? " tool-menu__trigger--open" : ""}`}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        title={label}
        onMouseDown={(e) => e.preventDefault()} // keep editor selection
        onClick={onToggle}
      >
        {trigger}
        <svg className="tool-menu__caret" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 3.5 5 6.5l2.5-3" />
        </svg>
      </button>
      {open && (
        <div className="tool-menu__panel" onMouseDown={(e) => e.preventDefault()}>
          {children}
        </div>
      )}
    </div>
  );
}

function Toolbar({
  editor,
  onAddTasks,
  showTasks,
}: {
  editor: Editor | null;
  onAddTasks: (lines: string[]) => void;
  showTasks: boolean;
}) {
  // In TipTap v3, useEditor does not re-render on every transaction. Derive the
  // active states reactively so highlights track the cursor (and clear when it
  // leaves formatted text) instead of getting stuck "on" after a command.
  // hasSelection drives the clock button (enabled only when text is selected).
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
            hasSelection: !editor.state.selection.empty,
          }
        : null,
  });

  const [openMenu, setOpenMenu] = useState<"heading" | "style" | "list" | null>(null);

  if (!editor || !active) return <div className="toolbar" />;
  const chain = () => editor.chain().focus();
  const closeMenu = () => setOpenMenu(null);

  // Send the current selection to the left task list — one task per line. The
  // toolbar buttons preventDefault on mousedown, so the selection survives the
  // click. Block nodes (paragraphs, list items) are separated by "\n".
  function addSelectionAsTasks() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, "\n", "\n");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) onAddTasks(lines);
  }
  return (
    <div className="toolbar">
      <MenuBar
        label="Heading"
        trigger={<span className="tool__txt">H</span>}
        active={active.h1 || active.h2}
        open={openMenu === "heading"}
        onToggle={() => setOpenMenu((m) => (m === "heading" ? null : "heading"))}
        onClose={closeMenu}
      >
        <Btn label="Heading 1" active={active.h1} onClick={() => { chain().toggleHeading({ level: 1 }).run(); closeMenu(); }}>
          <span className="tool__txt">H1</span>
        </Btn>
        <Btn label="Heading 2" active={active.h2} onClick={() => { chain().toggleHeading({ level: 2 }).run(); closeMenu(); }}>
          <span className="tool__txt">H2</span>
        </Btn>
      </MenuBar>

      <MenuBar
        label="Style"
        trigger={<span className="tool__txt" style={{ fontStyle: "italic", fontFamily: "Fraunces, serif" }}>Aa</span>}
        active={active.bold || active.italic || active.strike}
        open={openMenu === "style"}
        onToggle={() => setOpenMenu((m) => (m === "style" ? null : "style"))}
        onClose={closeMenu}
      >
        <Btn label="Bold" active={active.bold} onClick={() => { chain().toggleBold().run(); closeMenu(); }}>
          <span className="tool__txt" style={{ fontWeight: 700 }}>B</span>
        </Btn>
        <Btn label="Italic" active={active.italic} onClick={() => { chain().toggleItalic().run(); closeMenu(); }}>
          <span className="tool__txt" style={{ fontStyle: "italic", fontFamily: "Fraunces, serif" }}>I</span>
        </Btn>
        <Btn label="Strikethrough" active={active.strike} onClick={() => { chain().toggleStrike().run(); closeMenu(); }}>
          <span className="tool__txt" style={{ textDecoration: "line-through" }}>S</span>
        </Btn>
      </MenuBar>

      <MenuBar
        label="List"
        trigger={
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="3" cy="4.5" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="3" cy="9" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="3" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
            <path d="M7 4.5h8M7 9h8M7 13.5h8" />
          </svg>
        }
        active={active.bullet || active.ordered || active.task}
        open={openMenu === "list"}
        onToggle={() => setOpenMenu((m) => (m === "list" ? null : "list"))}
        onClose={closeMenu}
      >
        <Btn label="Bullet list" active={active.bullet} onClick={() => { chain().toggleBulletList().run(); closeMenu(); }}>
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="3" cy="4.5" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="3" cy="9" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="3" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
            <path d="M7 4.5h8M7 9h8M7 13.5h8" />
          </svg>
        </Btn>
        <Btn label="Numbered list" active={active.ordered} onClick={() => { chain().toggleOrderedList().run(); closeMenu(); }}>
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 4.5h7M8 9h7M8 13.5h7" />
            <path d="M2 3.2h1.2v3M1.7 13.9h1.6M1.7 11.6c0-.6 1.5-.6 1.5.2 0 .5-1.5 1-1.5 2.1" stroke="currentColor" />
          </svg>
        </Btn>
        <Btn label="Checklist" active={active.task} onClick={() => { chain().toggleTaskList().run(); closeMenu(); }}>
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2" width="6" height="6" rx="1.4" />
            <path d="M2.8 5l1.3 1.3 2-2.4" />
            <path d="M10.5 5h5.5M10.5 12.5h5.5" />
            <rect x="1.5" y="9.5" width="6" height="6" rx="1.4" />
          </svg>
        </Btn>
      </MenuBar>

      {showTasks && (
        <>
          <span className="toolbar__sep" />

          <Btn
            label="Add selected lines to tasks"
            disabled={!active.hasSelection}
            onClick={addSelectionAsTasks}
          >
            <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="9" r="6.75" />
              <path d="M9 5.2V9l2.6 1.6" />
            </svg>
          </Btn>
        </>
      )}
    </div>
  );
}

export const LINE_DRAG_MIME = "application/x-focusbox-line";

export default function Notes({ doc, onChange, onAddTasks, onEditorReady, onLineDragChange, showTasks, focusDone }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      FocusedLine,
      Placeholder.configure({
        placeholder:
          "Start writing…  Use the bar above, or type “# ”, “- ”, “[ ] ” for instant formatting.",
      }),
    ],
    content: doc ?? "",
    onUpdate: ({ editor }) => onChange(editor.getJSON() as NotesDoc),
  });
  const [handleTop, setHandleTop] = useState<number | null>(null);
  const hoveredLi = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
  }, [doc, editor]);

  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  // Track which draggable line the pointer is over; position the handle beside it.
  function onMouseMove(e: React.MouseEvent) {
    const li = (e.target as HTMLElement).closest?.(
      'ul[data-type="taskList"] > li, ul:not([data-type="taskList"]) > li',
    ) as HTMLElement | null;
    // Exclude ordered lists implicitly (selector matches ULs only).
    if (li && scrollRef.current?.contains(li)) {
      hoveredLi.current = li;
      const box = li.getBoundingClientRect();
      const host = scrollRef.current.getBoundingClientRect();
      setHandleTop(box.top - host.top + scrollRef.current.scrollTop);
    } else {
      if ((e.target as HTMLElement).closest?.(".line-handle")) return;
      hoveredLi.current = null;
      setHandleTop(null);
    }
  }
  function onMouseLeave() {
    hoveredLi.current = null;
    setHandleTop(null);
  }

  function onHandleDragStart(e: React.DragEvent) {
    const li = hoveredLi.current;
    const view = editor?.view;
    if (!li || !view) return;
    // posAtDOM(li, 0) = position at the start of the li's content; the node
    // itself starts one position earlier.
    const pos = view.posAtDOM(li, 0) - 1;
    e.dataTransfer.setData(LINE_DRAG_MIME, String(pos));
    e.dataTransfer.effectAllowed = "copy";
    onLineDragChange(true);
  }
  function onHandleDragEnd() {
    onLineDragChange(false);
  }

  return (
    <section className={`notes${focusDone ? " notes--focus-done" : ""}`}>
      <Toolbar editor={editor} onAddTasks={onAddTasks} showTasks={showTasks} />
      <div
        className="notes__scroll"
        ref={scrollRef}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onScroll={() => {
          hoveredLi.current = null;
          setHandleTop(null);
        }}
      >
        <EditorContent editor={editor} className="notes__editor" />
        {handleTop !== null && (
          <button
            type="button"
            className="line-handle"
            style={{ top: handleTop }}
            aria-label="Drag line to focus"
            title="Drag under the timer to focus on this task"
            draggable
            onDragStart={onHandleDragStart}
            onDragEnd={onHandleDragEnd}
            onMouseDown={(e) => e.preventDefault()} // don't steal editor focus
          >
            ⠿
          </button>
        )}
      </div>
    </section>
  );
}
