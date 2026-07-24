import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import Timer from "./components/Timer";
import TaskList from "./components/TaskList";
import Notes, { LINE_DRAG_MIME } from "./components/Notes";
import FocusCard from "./components/FocusCard";
import Settings from "./components/Settings";
import SpotifyPlayer from "./components/SpotifyPlayer";
import UpdateBanner from "./components/UpdateBanner";
import { checkForUpdate, installUpdateAndRestart, type UpdateInfo } from "./lib/updater";
import { loadState, saveState, type NotesDoc } from "./lib/store";
import { getFocusedTask, clearFocused, markFocusedDone, clearDone } from "./lib/focusedLine";
import type { SyncedTask } from "./lib/syncTypes";
import { reconcileTasks, visibleTasks, type VisibleTask } from "./lib/taskMap";
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
import { getShowTasks, storeShowTasks } from "./lib/tasksVisibility";
import { getMenubarTimer, storeMenubarTimer } from "./lib/trayVisibility";
import { initTray, setTrayTitle, destroyTray, trayTitleFor, isTrayAvailable } from "./lib/tray";
import { isDemo } from "./lib/demo";

export default function App() {
  const demo = isDemo();
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState<SyncedTask[]>([]);
  const [notesDoc, setNotesDoc] = useState<NotesDoc>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredMode);
  const [accent, setAccent] = useState<AccentId>(getStoredAccent);
  const [playerVisible, setPlayerVisible] = useState<boolean>(getPlayerVisible);
  const [showTasks, setShowTasks] = useState<boolean>(getShowTasks);
  const [menubarTimer, setMenubarTimer] = useState<boolean>(getMenubarTimer);
  // Latest tray display string, derived from Timer's onTick — null means "icon only".
  const [trayText, setTrayText] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const [lineDragging, setLineDragging] = useState(false);
  const focusTask = getFocusedTask(notesDoc);

  // Cloud sync (optional). getLocal reads current state; onMerged applies a merged
  // result back. The hook keeps both in refs, so passing fresh closures each render
  // is safe and avoids stale state.
  const sync = useSync({
    enabled: loaded && !demo,
    getLocal: () => ({
      tasks,
      notesDoc,
      settings: { theme: themeMode, accent, spotifyEnabled: playerVisible, showTasks, menubarTimer },
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
      if (m.settings.showTasks !== showTasks) setShowTasks(m.settings.showTasks);
      if (m.settings.menubarTimer !== menubarTimer) setMenubarTimer(m.settings.menubarTimer);
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
    return () => {
      active = false;
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

  // Persist the "show tasks" preference.
  useEffect(() => {
    storeShowTasks(showTasks);
  }, [showTasks]);

  // Persist the "menubar timer" preference.
  useEffect(() => {
    storeMenubarTimer(menubarTimer);
  }, [menubarTimer]);

  // Create/destroy the macOS tray item as the setting is toggled (no-op off-mac/web).
  useEffect(() => {
    if (!isTrayAvailable || !menubarTimer) {
      destroyTray();
      return;
    }
    initTray();
    return () => {
      destroyTray();
    };
  }, [menubarTimer]);

  // Push the latest tray title whenever it changes (setTrayTitle no-ops on unchanged
  // text and off-mac/web, so this is cheap to call unconditionally).
  useEffect(() => {
    if (!isTrayAvailable || !menubarTimer) return;
    setTrayTitle(trayText);
  }, [menubarTimer, trayText]);

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
      // Compose with clearFocused: on a time's-up Reset this runs right after
      // handleTimerReset in the same event, both reading the same stale notesDoc —
      // without composing, this write would resurrect the cleared focused attr.
      updateNotes(appendTaskLines(clearFocused(notesDoc), unmarked));
    }
  }

  // Core "focus this line" logic, shared by the drag-handle drop and the
  // toolbar button. The editor command mutates the doc, which flows back via
  // onUpdate → updateNotes. If the line was already done (struck / checked),
  // also clear that done state so it becomes the ACTIVE focus task rather
  // than an immediately-dead "done" card — both are a clear "focus on this"
  // signal.
  function focusLineAt(pos: number) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.commands.setFocusedLineAt(pos);
    const withFocus = editor.getJSON() as NotesDoc;
    const cleared = clearDone(withFocus);
    if (cleared !== withFocus) {
      editor.commands.setContent(cleared, { emitUpdate: true });
    }
    // Marking a focus task is a terminal action on that line — collapse any
    // text selection and drop editor focus so the blue macOS selection doesn't
    // linger until the user clicks elsewhere. Deferred a frame: the setContent
    // above (and the toolbar button's own focus-preserving mousedown handling)
    // would otherwise restore the selection right after we clear it.
    requestAnimationFrame(() => {
      editor.commands.setTextSelection(editor.state.selection.from);
      editor.commands.blur();
      window.getSelection()?.removeAllRanges();
    });
  }

  // Drop from the notepad drag-handle: mark that line as the focus task.
  function handleFocusDrop(e: React.DragEvent) {
    e.preventDefault();
    setLineDragging(false);
    const raw = e.dataTransfer.getData(LINE_DRAG_MIME);
    if (!raw) return;
    const pos = Number(raw);
    if (!Number.isInteger(pos) || pos < 0) return;
    focusLineAt(pos);
  }

  // Card ✓/✕: write done into the note (strike/check), keep the card until reset.
  // Blur first: Notes only applies external doc changes while unfocused (see the
  // isFocused guard in Notes.tsx), same trick as handleTimeUpReset.
  function handleFocusDone() {
    (document.activeElement as HTMLElement | null)?.blur();
    updateNotes(markFocusedDone(notesDoc));
  }

  // Any user Reset clears the focus task (highlight + card). Done strikethrough
  // stays in the note — clearFocused only drops the attribute.
  function handleTimerReset() {
    if (!focusTask) return;
    (document.activeElement as HTMLElement | null)?.blur();
    updateNotes(clearFocused(notesDoc));
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
  function changeShowTasks(visible: boolean) {
    setShowTasks(visible);
    sync.notifySettingsChanged(Date.now());
  }
  function changeMenubarTimer(visible: boolean) {
    setMenubarTimer(visible);
    sync.notifySettingsChanged(Date.now());
  }

  // Timer tick/status -> tray display string (running "mm:ss" / paused frozen /
  // finished "0:00" / idle icon-only). Cheap to call every tick; setTrayTitle itself
  // no-ops on unchanged text and off-mac/web.
  const handleTimerTick = useCallback((remainingMs: number, status: string) => {
    setTrayText(trayTitleFor(status, remainingMs));
  }, []);

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
        <Timer onTimeUpReset={handleTimeUpReset} onReset={handleTimerReset} onTick={handleTimerTick} />
        {(lineDragging || focusTask) && (
          <div
            className={`focus-slot${lineDragging ? " focus-slot--target" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={handleFocusDrop}
          >
            {focusTask ? (
              <FocusCard task={focusTask} onDone={handleFocusDone} onDismiss={handleTimerReset} />
            ) : (
              <span className="focus-slot__hint">drop here to focus</span>
            )}
          </div>
        )}
        {showTasks && <TaskList tasks={visibleTasks(tasks)} onChange={updateTasks} />}
        {isSpotifyAvailable && playerVisible && <SpotifyPlayer />}
      </aside>
      <main className="app__notes">
        <Notes
          doc={notesDoc}
          onChange={updateNotes}
          onEditorReady={(ed) => { editorRef.current = ed; }}
          onLineDragChange={setLineDragging}
          onFocusLine={focusLineAt}
          focusDone={!!focusTask?.done}
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
        showTasks={showTasks}
        onShowTasksChange={changeShowTasks}
        menubarTimer={menubarTimer}
        onMenubarTimerChange={changeMenubarTimer}
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
