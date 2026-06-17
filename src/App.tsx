import { useEffect, useState } from "react";
import Timer from "./components/Timer";
import TaskList from "./components/TaskList";
import Notes from "./components/Notes";
import { loadState, saveState, type Task, type NotesDoc } from "./lib/store";

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notesDoc, setNotesDoc] = useState<NotesDoc>(null);

  // Hydrate persisted state once on mount.
  useEffect(() => {
    let active = true;
    loadState().then((state) => {
      if (!active) return;
      setTasks(state.tasks);
      setNotesDoc(state.notesDoc);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  function updateTasks(next: Task[]) {
    setTasks(next);
    saveState({ tasks: next });
  }

  function updateNotes(next: NotesDoc) {
    setNotesDoc(next);
    saveState({ notesDoc: next });
  }

  if (!loaded) {
    return <div className="loading">Loading…</div>;
  }

  return (
    <div className="app">
      <aside className="app__left">
        <Timer />
        <TaskList tasks={tasks} onChange={updateTasks} />
      </aside>
      <main className="app__right">
        <Notes doc={notesDoc} onChange={updateNotes} />
      </main>
    </div>
  );
}
