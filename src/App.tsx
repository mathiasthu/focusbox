import { useEffect, useRef, useState } from "react";
import Timer from "./components/Timer";
import TaskList from "./components/TaskList";
import Notes, { type NotesHandle, type PromotePayload } from "./components/Notes";
import FocusCard from "./components/FocusCard";
import Settings from "./components/Settings";
import SpotifyPlayer from "./components/SpotifyPlayer";
import UpdateBanner from "./components/UpdateBanner";
import { checkForUpdate, installUpdateAndRestart, type UpdateInfo } from "./lib/updater";
import { loadState, saveState, loadFocusItem, saveFocusItem, type NotesDoc } from "./lib/store";
import type { SyncedTask } from "./lib/syncTypes";
import type { FocusItem } from "./lib/focusReturn";
import { newTaskId, reconcileTasks, visibleTasks, type VisibleTask } from "./lib/taskMap";
import { appendTaskLines } from "./lib/notesEdit";
import { useSync } from "./hooks/useSync";
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
import { getPlayerVisible, storePlayerVisible, isSpotifyAvailable } from "./lib/spotify";
import { isDemo } from "./lib/demo";

export default function App() {
  const demo = isDemo();
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState<SyncedTask[]>([]);
  const [notesDoc, setNotesDoc] = useState<NotesDoc>(null);
  // The single active task pinned under the clock (local-only; see store.ts). Notes
  // owns the notes-doc mutations, so returning a task to the notes goes through this ref.
  const [focusItem, setFocusItem] = useState<FocusItem | null>(null);
  const notesRef = useRef<NotesHandle>(null);
  // True while any drag is in flight, so the focus card can reveal a drop target
  // only when needed (keeps the panel uncluttered when idle).
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredMode);
  const [accent, setAccent] = useState<AccentId>(getStoredAccent);
  const [playerVisible, setPlayerVisible] = useState<boolean>(getPlayerVisible);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Cloud sync (optional). getLocal reads current state; onMerged applies a merged
  // result back. The hook keeps both in refs, so passing fresh closures each render
  // is safe and avoids stale state.
  const sync = useSync({
    enabled: loaded && !demo,
    getLocal: () => ({
      tasks,
      notesDoc,
      settings: { theme: themeMode, accent, spotifyEnabled: playerVisible },
    }),
    onMerged: (m) => {
      // Only touch state that actually changed, so a no-op sync (e.g. window focus)
      // doesn't churn re-renders or persistence.
      if (JSON.stringify(m.tasks) !== JSON.stringify(tasks)) {
        setTasks(m.tasks);
        saveState({ tasks: m.tasks });
      }
      if (JSON.stringify(m.notesDoc) !== JSON.stringify(notesDoc)) {
        setNotesDoc(m.notesDoc);
        saveState({ notesDoc: m.notesDoc });
      }
      // Apply merged settings via the RAW setters (no notify → no sync loop).
      if (m.settings.theme !== themeMode) setThemeMode(m.settings.theme as ThemeMode);
      if (m.settings.accent !== accent) setAccent(m.settings.accent as AccentId);
      if (m.settings.spotifyEnabled !== playerVisible) setPlayerVisible(m.settings.spotifyEnabled);
    },
  });

  // Hydrate persisted state once on mount.
  useEffect(() => {
    let active = true;
    loadState().then((state) => {
      if (!active) return;
      setTasks(state.tasks);
      setNotesDoc(state.notesDoc);
      setLoaded(true);
    });
    // Restore a focus task parked under the clock from a previous session.
    loadFocusItem().then((item) => {
      if (active && item) setFocusItem(item);
    });
    return () => {
      active = false;
    };
  }, []);

  // Track whether a drag is happening anywhere, to reveal the focus drop target.
  useEffect(() => {
    const start = () => setDragging(true);
    const end = () => setDragging(false);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, []);

  // Check for an app update once on launch (desktop only; no-ops in the browser).
  useEffect(() => {
    if (demo) return;
    checkForUpdate().then((info) => {
      if (info) setUpdate(info);
    });
  }, [demo]);

  // Apply + persist the theme whenever it changes, and follow the OS when on
  // "system". (Applying is idempotent for both user and merged-remote changes.)
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

  // Persist the Spotify-player visibility preference.
  useEffect(() => {
    storePlayerVisible(playerVisible);
  }, [playerVisible]);

  // ---- task editing: reconcile the slim UI list into the canonical SyncedTask[] ----
  function updateTasks(next: VisibleTask[]) {
    const reconciled = reconcileTasks(tasks, next, Date.now());
    setTasks(reconciled);
    saveState({ tasks: reconciled });
    sync.notifyTasksChanged();
  }

  function updateNotes(next: NotesDoc) {
    setNotesDoc(next);
    saveState({ notesDoc: next });
    sync.notifyNotesChanged(Date.now());
  }

  // ---- focus card (the active task under the clock) ----
  // Persist on every change in the same call (no effect) to avoid a load-race that
  // could overwrite the restored item with the initial null.
  function setFocus(next: FocusItem | null) {
    setFocusItem(next);
    saveFocusItem(next);
  }

  // A notepad line was promoted (Notes already removed it from the doc). If a
  // *promoted* task still occupies the card, return it to the notes first; a
  // *dragged-in* plain-text task (origin null) is simply replaced since it
  // never left the notes.
  function promoteFocus(p: PromotePayload) {
    if (focusItem?.origin) notesRef.current?.returnToNotes(focusItem);
    setFocus({ text: p.text, done: false, origin: { path: p.path, node: p.node } });
  }

  // A notepad line was dragged onto the card. Notes stashed the line on
  // dragstart; taking it deletes it from the doc and hands back the payload
  // (move semantics). Plain-text drags from outside the editor fall back to a
  // no-origin item.
  function dropSetFocus(text: string) {
    const p = notesRef.current?.takePendingDrag();
    if (p) {
      promoteFocus(p);
      return;
    }
    if (focusItem?.origin) notesRef.current?.returnToNotes(focusItem);
    setFocus({ text, done: false, origin: null });
  }

  // Resolve the card: return a promoted task to the notes (done → struck
  // through; not done → verbatim), then clear. Used by every Reset, the
  // complete checkbox AND the eject ✕.
  function resolveFocus(item?: FocusItem) {
    const current = item ?? focusItem;
    if (!current) return;
    notesRef.current?.returnToNotes(current); // no-op for no-origin items
    setFocus(null);
  }

  // Completing the task resolves the card immediately (returns the line to the
  // notes struck through).
  function setFocusDone(done: boolean) {
    if (!focusItem) return;
    if (done) resolveFocus({ ...focusItem, done: true });
    else setFocus({ ...focusItem, done: false });
  }

  // Fired on EVERY Reset click: an unresolved focus task goes back to the notes.
  // The left-tasklist shuffle stays gated to the end-of-session (time's-up) reset.
  function handleReset(wasFinished: boolean) {
    if (focusItem) {
      (document.activeElement as HTMLElement | null)?.blur();
      resolveFocus();
    }
    if (wasFinished) handleTimeUpReset();
  }

  // Clock toolbar button: each selected notepad line becomes a new left task.
  function addTasksFromNotes(lines: string[]) {
    const additions: VisibleTask[] = lines.map((text) => ({
      id: newTaskId(),
      text,
      done: false,
    }));
    if (additions.length === 0) return;
    updateTasks([...visibleTasks(tasks), ...additions]);
  }

  // End-of-session reset (fired only when the timer ran out): drop the marked
  // (completed) tasks, return the unmarked ones to the notepad as lines, and
  // leave the left task list empty.
  function handleTimeUpReset() {
    const visible = visibleTasks(tasks);
    if (visible.length === 0) return;
    const unmarked = visible.filter((t) => !t.done).map((t) => t.text);
    updateTasks([]);
    if (unmarked.length > 0) {
      // The notepad only picks up an external doc change while it is NOT focused
      // (see the effect in Notes.tsx). On macOS WebKit, clicking the timer's
      // Reset button does NOT blur a focused contenteditable, so blur it here —
      // otherwise the returned task lines would never render and the next
      // keystroke would overwrite them. Harmless no-op when nothing is focused.
      (document.activeElement as HTMLElement | null)?.blur();
      updateNotes(appendTaskLines(notesDoc, unmarked));
    }
  }

  // Settings changes from the UI: set state AND tell sync (merged-remote changes use
  // the raw setters in onMerged, which don't notify).
  function changeTheme(mode: ThemeMode) {
    setThemeMode(mode);
    sync.notifySettingsChanged(Date.now());
  }
  function changeAccent(id: AccentId) {
    setAccent(id);
    sync.notifySettingsChanged(Date.now());
  }
  function changePlayerVisible(visible: boolean) {
    setPlayerVisible(visible);
    sync.notifySettingsChanged(Date.now());
  }

  // Download + install the update, then relaunch. On Windows the installer closes the
  // app to apply, so only run this once the user has chosen to restart.
  async function restartToUpdate() {
    setUpdateBusy(true);
    setUpdateError(false);
    try {
      await installUpdateAndRestart();
    } catch (e) {
      console.error("Focusbox: update install failed.", e);
      setUpdateBusy(false);
      setUpdateError(true);
    }
  }

  if (!loaded) {
    return <div className="loading">Loading…</div>;
  }

  return (
    <div className="app">
      <aside className="app__focus">
        <svg className="wordmark" viewBox="35 44 452 60" role="img" aria-label="Focusbox" fill="none">
          <title>Focusbox</title>
          <g transform="translate(16,20) scale(1.1)">
            <rect x="19" y="24.37" width="62" height="10.73" rx="5.37" fill="#E8920D" />
            <rect x="19" y="44.63" width="50.08" height="10.73" rx="5.37" fill="currentColor" />
            <rect x="19" y="64.90" width="35.77" height="10.73" rx="5.37" fill="currentColor" />
          </g>
          <text x="156" y="98" fontFamily="'Hanken Grotesk', sans-serif" fontWeight="700" fontSize="72" letterSpacing="-2.5" fill="currentColor">focusbox</text>
        </svg>
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
        <Timer onReset={handleReset} />
        <FocusCard
          item={focusItem}
          dragging={dragging}
          onToggleDone={setFocusDone}
          onEject={() => {
            if (focusItem) resolveFocus({ ...focusItem, done: false }); // ✕ = cancel, verbatim
          }}
          onDropText={dropSetFocus}
        />
        <TaskList tasks={visibleTasks(tasks)} onChange={updateTasks} />
        {isSpotifyAvailable && playerVisible && <SpotifyPlayer />}
      </aside>
      <main className="app__notes">
        <Notes
          ref={notesRef}
          doc={notesDoc}
          onChange={updateNotes}
          onPromote={promoteFocus}
          onAddTasks={addTasksFromNotes}
        />
      </main>

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeMode={themeMode}
        onThemeChange={changeTheme}
        accent={accent}
        onAccentChange={changeAccent}
        playerVisible={playerVisible}
        onPlayerVisibleChange={changePlayerVisible}
        sync={sync}
        demo={demo}
      />

      {update && !updateDismissed && (
        <UpdateBanner
          version={update.version}
          busy={updateBusy}
          error={updateError}
          onRestart={restartToUpdate}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}
    </div>
  );
}
