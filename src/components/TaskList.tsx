import { useState } from "react";
import type { Task } from "../lib/store";

interface Props {
  tasks: Task[];
  onChange: (tasks: Task[]) => void;
}

function newId(): string {
  // Random enough for local task ids; avoids needing a uuid dep.
  return `${performance.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function TaskList({ tasks, onChange }: Props) {
  const [draft, setDraft] = useState("");

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

  return (
    <section className="tasks">
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
            <label className="task__main">
              <input
                type="checkbox"
                checked={task.done}
                onChange={() => toggle(task.id)}
              />
              <span className="task__text">{task.text}</span>
            </label>
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
