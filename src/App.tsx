import { useEffect, useState } from "react";
import Timer from "./components/Timer";
import TaskList from "./components/TaskList";
import Notes from "./components/Notes";
import { loadState, saveState, type Task, type NotesDoc } from "./lib/store";
import { SUPPORT_URL } from "./lib/config";

// Open an external URL: use Tauri's opener in the app, window.open in a browser.
async function openExternal(url: string) {
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

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
      <aside className="app__focus">
        <span className="wordmark">Focusbox</span>
        <Timer />
        <TaskList tasks={tasks} onChange={updateTasks} />
        <button
          className="support"
          onClick={() => openExternal(SUPPORT_URL)}
          title="Support Focusbox"
        >
          <span className="support__heart">♥</span> Support Focusbox
        </button>
      </aside>
      <main className="app__notes">
        <Notes doc={notesDoc} onChange={updateNotes} />
      </main>
    </div>
  );
}
