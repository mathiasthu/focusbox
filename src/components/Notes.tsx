import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import type { ReactNode } from "react";
import type { NotesDoc } from "../lib/store";

interface Props {
  doc: NotesDoc;
  onChange: (doc: NotesDoc) => void;
}

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

export default function Notes({ doc, onChange }: Props) {
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

  return (
    <section className="notes">
      <Toolbar editor={editor} />
      <div className="notes__scroll">
        <EditorContent editor={editor} className="notes__editor" />
      </div>
    </section>
  );
}
