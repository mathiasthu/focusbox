import { useState } from "react";
import { newTaskId, type VisibleTask } from "../lib/taskMap";

interface Props {
  tasks: VisibleTask[];
  onChange: (tasks: VisibleTask[]) => void;
}

export default function TaskList({ tasks, onChange }: Props) {
  const [draft, setDraft] = useState("");

  function addTask() {
    const text = draft.trim();
    if (!text) return;
    onChange([...tasks, { id: newTaskId(), text, done: false }]);
    setDraft("");
  }

  // Clicking a task toggles its "marked" state. Marked IS the completed/checked-off
  // state (one state only — no separate checkbox); the timer-reset flow clears
  // marked tasks and returns unmarked ones to the notepad.
  function toggle(id: string) {
    onChange(tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }

  function remove(id: string) {
    onChange(tasks.filter((t) => t.id !== id));
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
          <li key={task.id} className={`task${task.done ? " task--marked" : ""}`}>
            <button
              type="button"
              className="task__toggle"
              aria-pressed={task.done}
              onClick={() => toggle(task.id)}
              title={task.done ? "Marked — click to unmark" : "Click to mark"}
            >
              <span className="task__text">{task.text}</span>
            </button>
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
