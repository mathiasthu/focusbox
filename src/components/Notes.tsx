import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, type ReactNode } from "react";
import type { NotesDoc } from "../lib/store";
import { FocusedLine } from "../lib/focusedLineExtension";

interface Props {
  doc: NotesDoc;
  onChange: (doc: NotesDoc) => void;
  onAddTasks: (lines: string[]) => void;
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

function Toolbar({
  editor,
  onAddTasks,
}: {
  editor: Editor | null;
  onAddTasks: (lines: string[]) => void;
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

  if (!editor || !active) return <div className="toolbar" />;
  const chain = () => editor.chain().focus();

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
    </div>
  );
}

export default function Notes({ doc, onChange, onAddTasks }: Props) {
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

  return (
    <section className="notes">
      <Toolbar editor={editor} onAddTasks={onAddTasks} />
      <div className="notes__scroll">
        <EditorContent editor={editor} className="notes__editor" />
      </div>
    </section>
  );
}
