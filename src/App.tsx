import { useEffect, useState } from "react";
import Timer from "./components/Timer";
import TaskList from "./components/TaskList";
import Notes from "./components/Notes";
import Settings from "./components/Settings";
import { loadState, saveState, type Task, type NotesDoc } from "./lib/store";
import {
  applyTheme,
  getStoredMode,
  storeMode,
  type ThemeMode,
} from "./lib/theme";
import {
  applyAccent,
  getStoredAccent,
  storeAccent,
  type AccentId,
} from "./lib/accent";

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notesDoc, setNotesDoc] = useState<NotesDoc>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredMode);
  const [accent, setAccent] = useState<AccentId>(getStoredAccent);

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

  // Apply + persist the theme whenever it changes, and follow the OS when on
  // "system".
  useEffect(() => {
    applyTheme(themeMode);
    storeMode(themeMode);
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (themeMode === "system") applyTheme("system");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [themeMode]);

  // Apply + persist the accent color whenever it changes.
  useEffect(() => {
    applyAccent(accent);
    storeAccent(accent);
  }, [accent]);

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
        <button
          className="iconbtn gear"
          aria-label="Settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <Timer />
        <TaskList tasks={tasks} onChange={updateTasks} />
      </aside>
      <main className="app__notes">
        <Notes doc={notesDoc} onChange={updateNotes} />
      </main>

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeMode={themeMode}
        onThemeChange={setThemeMode}
        accent={accent}
        onAccentChange={setAccent}
      />
    </div>
  );
}
