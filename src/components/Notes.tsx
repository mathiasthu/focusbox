import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import type { NotesDoc } from "../lib/store";

interface Props {
  doc: NotesDoc;
  onChange: (doc: NotesDoc) => void;
}

export default function Notes({ doc, onChange }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder:
          "Notes…  Try “# ” for a heading, “- ” for a list, “[ ] ” for a checkbox.",
      }),
    ],
    // Content is set once at mount; the parent only renders after state loads.
    content: doc ?? "",
    onUpdate: ({ editor }) => onChange(editor.getJSON() as NotesDoc),
  });

  return (
    <section className="notes">
      <EditorContent editor={editor} className="notes__editor" />
    </section>
  );
}
