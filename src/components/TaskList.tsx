import { useRef, useState } from "react";
import type { VisibleTask } from "../lib/taskMap";

interface Props {
  tasks: VisibleTask[];
  onChange: (tasks: VisibleTask[]) => void;
}

function newId(): string {
  // Random enough for local task ids; avoids needing a uuid dep.
  return `${performance.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function TaskList({ tasks, onChange }: Props) {
  const [draft, setDraft] = useState("");
  // Which task is being renamed inline (null = none), plus its working text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // Set when Escape cancels an edit, so the blur it triggers doesn't also commit.
  const skipCommitRef = useRef(false);

  function addTask() {
    const text = draft.trim();
    if (!text) return;
    onChange([...tasks, { id: newId(), text, done: false }]);
    setDraft("");
  }

  function toggle(id: string) {
    onChange(tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }

  function remove(id: string) {
    onChange(tasks.filter((t) => t.id !== id));
  }

  function startEdit(task: VisibleTask) {
    setEditingId(task.id);
    setEditText(task.text);
  }

  // Commit the rename (called on blur — Enter blurs the field to get here). An empty
  // name is ignored so a task can't be renamed into nothing; Escape skips committing.
  function commitEdit() {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      setEditingId(null);
      return;
    }
    const id = editingId;
    if (id === null) return;
    const text = editText.trim();
    if (text) {
      onChange(tasks.map((t) => (t.id === id ? { ...t, text } : t)));
    }
    setEditingId(null);
  }

  function onEditKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.currentTarget.blur(); // → commitEdit
    } else if (e.key === "Escape") {
      skipCommitRef.current = true;
      e.currentTarget.blur(); // → commitEdit (skips, just exits)
    }
  }

  const remaining = tasks.filter((t) => !t.done).length;

  return (
    <section className="tasks">
      <header className="tasks__header">
        <h2 className="tasks__title">Tasks</h2>
        {tasks.length > 0 && (
          <span className="tasks__count">{remaining} left</span>
        )}
      </header>
      <div className="tasks__add">
        <input
          className="tasks__input"
          type="text"
          placeholder="Add a task…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTask();
          }}
        />
      </div>

      <ul className="tasks__list">
        {tasks.map((task) => (
          <li key={task.id} className={`task${task.done ? " task--done" : ""}`}>
            <input
              type="checkbox"
              checked={task.done}
              onChange={() => toggle(task.id)}
              aria-label={task.done ? `Mark "${task.text}" not done` : `Mark "${task.text}" done`}
            />
            {editingId === task.id ? (
              <input
                className="task__edit"
                type="text"
                value={editText}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={onEditKey}
                onBlur={commitEdit}
                aria-label="Rename task"
              />
            ) : (
              <button
                type="button"
                className="task__text"
                onClick={() => startEdit(task)}
                title="Click to rename"
              >
                {task.text}
              </button>
            )}
            <button
              className="task__delete"
              aria-label="Delete task"
              onClick={() => remove(task.id)}
            >
              ×
            </button>
          </li>
        ))}
        {tasks.length === 0 && (
          <li className="tasks__empty">No tasks yet — add one above.</li>
        )}
      </ul>
    </section>
  );
}
