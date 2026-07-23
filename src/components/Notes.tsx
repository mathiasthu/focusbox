import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useRef, useState, type ReactNode, type DragEvent } from "react";
import type { ChainedCommands } from "@tiptap/core";
import type { NotesDoc } from "../lib/store";
import { FocusedLine } from "../lib/focusedLineExtension";
import { getPinned, storePinned, MAX_PINS, type ToolbarItemId } from "../lib/toolbarPins";

interface Props {
  doc: NotesDoc;
  onChange: (doc: NotesDoc) => void;
  onAddTasks: (lines: string[]) => void;
  onEditorReady: (editor: Editor | null) => void;
  onLineDragChange: (dragging: boolean) => void;
  onFocusLine: (pos: number) => void;
  showTasks: boolean;
  focusDone: boolean;
}

// Toolbar pin/unpin drag payload: "menu:<id>" (pinning) or "pinned:<id>" (unpinning).
const TOOLPIN_MIME = "application/x-focusbox-toolpin";

function Btn({
  active,
  onClick,
  label,
  children,
  disabled,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
  disabled?: boolean;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: (e: DragEvent) => void;
}) {
  return (
    <button
      type="button"
      className={`tool${active ? " tool--active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      // preventDefault on mousedown keeps the editor selection visually alive,
      // but it SUPPRESSES native dragstart in WebKit — so draggable buttons
      // skip it. On the CLICK path their commands still work (chain().focus()
      // restores the selection from ProseMirror state after the blur); on the
      // DRAG path no click fires, so drop handlers restore focus explicitly.
      onMouseDown={draggable ? undefined : (e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Compact dropdown grouping for the toolbar: a trigger button (highlighted when
// any contained item is active) that reveals an absolutely-positioned panel of
// items on click. Closes on outside click / Escape. Trigger + items use
// onMouseDown preventDefault so the editor selection survives, matching Btn.
function MenuBar({
  label,
  trigger,
  active,
  open,
  onToggle,
  onClose,
  onUnpinDrop,
  children,
}: {
  label: string;
  trigger: ReactNode;
  active?: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onUnpinDrop?: (id: string) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  function onDragOver(e: DragEvent) {
    if (!onUnpinDrop) return;
    if (!e.dataTransfer.types.includes(TOOLPIN_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }
  function onDrop(e: DragEvent) {
    if (!onUnpinDrop) return;
    const payload = e.dataTransfer.getData(TOOLPIN_MIME);
    if (!payload.startsWith("pinned:")) return; // a menu item dropped on a menu — ignore
    e.preventDefault();
    e.stopPropagation(); // handled here — don't let the toolbar's drop handler see it too
    onUnpinDrop(payload.slice("pinned:".length));
  }

  return (
    <div className="tool-menu" ref={ref} onDragOver={onDragOver} onDrop={onDrop}>
      <button
        type="button"
        className={`tool tool-menu__trigger${active ? " tool--active" : ""}${open ? " tool-menu__trigger--open" : ""}`}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        title={label}
        onMouseDown={(e) => e.preventDefault()} // keep editor selection
        onClick={onToggle}
      >
        {trigger}
        <svg className="tool-menu__caret" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 3.5 5 6.5l2.5-3" />
        </svg>
      </button>
      {open && (
        <div className="tool-menu__panel">
          {children}
        </div>
      )}
    </div>
  );
}

// Walk up from the selection's $from to the nearest listItem/taskItem ancestor
// (a "focusable" line for the timer's focus slot). Returns its doc position
// (the node itself, for setFocusedLineAt) plus whether it's already focused.
function findFocusableLine(editor: Editor): { pos: number; focused: boolean } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "listItem" || node.type.name === "taskItem") {
      return { pos: $from.before(d), focused: node.attrs.focused === true };
    }
  }
  return null;
}

// The reactive per-item active flags Toolbar derives via useEditorState.
interface ActiveState {
  h1: boolean;
  h2: boolean;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  hasSelection: boolean;
  focusableLine: { pos: number; focused: boolean } | null;
}

type MenuId = "heading" | "style" | "list";

interface ToolbarItemDef {
  id: ToolbarItemId;
  menu: MenuId;
  label: string;
  icon: ReactNode;
  isActive: (a: ActiveState) => boolean;
  run: (c: ChainedCommands) => ChainedCommands;
}

const bulletIcon = (
  <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="3" cy="4.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="3" cy="9" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="3" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
    <path d="M7 4.5h8M7 9h8M7 13.5h8" />
  </svg>
);

// Single source for the formatting tools: the dropdowns render the un-pinned
// subset, the pinned row renders the pinned subset.
const TOOLBAR_ITEMS: ToolbarItemDef[] = [
  { id: "h1", menu: "heading", label: "Heading 1", icon: <span className="tool__txt">H1</span>, isActive: (a) => a.h1, run: (c) => c.toggleHeading({ level: 1 }) },
  { id: "h2", menu: "heading", label: "Heading 2", icon: <span className="tool__txt">H2</span>, isActive: (a) => a.h2, run: (c) => c.toggleHeading({ level: 2 }) },
  { id: "bold", menu: "style", label: "Bold", icon: <span className="tool__txt" style={{ fontWeight: 700 }}>B</span>, isActive: (a) => a.bold, run: (c) => c.toggleBold() },
  { id: "italic", menu: "style", label: "Italic", icon: <span className="tool__txt" style={{ fontStyle: "italic", fontFamily: "Fraunces, serif" }}>I</span>, isActive: (a) => a.italic, run: (c) => c.toggleItalic() },
  { id: "strike", menu: "style", label: "Strikethrough", icon: <span className="tool__txt" style={{ textDecoration: "line-through" }}>S</span>, isActive: (a) => a.strike, run: (c) => c.toggleStrike() },
  { id: "bullet", menu: "list", label: "Bullet list", icon: bulletIcon, isActive: (a) => a.bullet, run: (c) => c.toggleBulletList() },
  {
    id: "ordered", menu: "list", label: "Numbered list",
    icon: (
      <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 4.5h7M8 9h7M8 13.5h7" />
        <path d="M2 3.2h1.2v3M1.7 13.9h1.6M1.7 11.6c0-.6 1.5-.6 1.5.2 0 .5-1.5 1-1.5 2.1" stroke="currentColor" />
      </svg>
    ),
    isActive: (a) => a.ordered, run: (c) => c.toggleOrderedList(),
  },
  {
    id: "task", menu: "list", label: "Checklist",
    icon: (
      <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.5" y="2" width="6" height="6" rx="1.4" />
        <path d="M2.8 5l1.3 1.3 2-2.4" />
        <path d="M10.5 5h5.5M10.5 12.5h5.5" />
        <rect x="1.5" y="9.5" width="6" height="6" rx="1.4" />
      </svg>
    ),
    isActive: (a) => a.task, run: (c) => c.toggleTaskList(),
  },
];

// The three dropdown groups, in display order. Trigger visuals unchanged.
const MENUS: { id: MenuId; label: string; trigger: ReactNode }[] = [
  { id: "heading", label: "Heading", trigger: <span className="tool__txt">H</span> },
  { id: "style", label: "Style", trigger: <span className="tool__txt" style={{ fontStyle: "italic", fontFamily: "Fraunces, serif" }}>Aa</span> },
  { id: "list", label: "List", trigger: bulletIcon },
];

function Toolbar({
  editor,
  onAddTasks,
  onFocusLine,
  showTasks,
}: {
  editor: Editor | null;
  onAddTasks: (lines: string[]) => void;
  onFocusLine: (pos: number) => void;
  showTasks: boolean;
}) {
  // In TipTap v3, useEditor does not re-render on every transaction. Derive the
  // active states reactively so highlights track the cursor (and clear when it
  // leaves formatted text) instead of getting stuck "on" after a command.
  // hasSelection drives the clock button (enabled only when text is selected).
  // focusableLine drives the "Focus this line" button: its pos (for the click
  // handler) and whether the cursor is already on the currently-focused line.
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
            hasSelection: !editor.state.selection.empty,
            focusableLine: findFocusableLine(editor),
          }
        : null,
  });

  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [pinned, setPinned] = useState<ToolbarItemId[]>(getPinned);
  const [pinTarget, setPinTarget] = useState(false);

  useEffect(() => {
    storePinned(pinned);
  }, [pinned]);

  if (!editor || !active) return <div className="toolbar" />;
  const chain = () => editor.chain().focus();
  const closeMenu = () => setOpenMenu(null);

  // Send the current selection to the left task list — one task per line. The
  // toolbar buttons preventDefault on mousedown, so the selection survives the
  // click. Block nodes (paragraphs, list items) are separated by "\n".
  function addSelectionAsTasks() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, "\n", "\n");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) onAddTasks(lines);
  }

  // Mark the bullet/checklist line the cursor is in as the timer's focus
  // task — same semantics as dragging the line-handle onto the focus slot.
  function focusCurrentLine() {
    if (!editor) return;
    const line = findFocusableLine(editor);
    if (!line) return;
    onFocusLine(line.pos);
  }

  function pinItem(id: ToolbarItemId) {
    setPinned((prev) => {
      const next = prev.filter((p) => p !== id);
      next.push(id);
      // Cap: bump the oldest pin back to its dropdown.
      return next.slice(-MAX_PINS);
    });
  }

  function unpinItem(id: ToolbarItemId) {
    setPinned((prev) => prev.filter((p) => p !== id));
  }

  function onToolbarDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes(TOOLPIN_MIME)) return;
    e.preventDefault(); // accept the drop (also for pinned:* — keeps dropEffect "move" so dragEnd won't unpin)
    e.dataTransfer.dropEffect = "move";
    setPinTarget(true);
  }

  function onToolbarDragLeave(e: DragEvent) {
    // dragleave also fires when entering a child button — ignore those.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setPinTarget(false);
  }

  function onToolbarDrop(e: DragEvent) {
    setPinTarget(false);
    const payload = e.dataTransfer.getData(TOOLPIN_MIME);
    if (!payload) return;
    e.preventDefault();
    const [source, id] = payload.split(":");
    if (source === "menu" && TOOLBAR_ITEMS.some((i) => i.id === id)) {
      pinItem(id as ToolbarItemId);
      closeMenu();
      editor?.commands.focus();
    }
    // source === "pinned": dropped back on the row — no-op, stays pinned (Task 5 adds unpin).
  }
  return (
    <div
      className={`toolbar${pinTarget ? " toolbar--pin-target" : ""}`}
      onDragOver={onToolbarDragOver}
      onDragLeave={onToolbarDragLeave}
      onDrop={onToolbarDrop}
    >
      {MENUS.map((menu) => {
        const items = TOOLBAR_ITEMS.filter((i) => i.menu === menu.id && !pinned.includes(i.id));
        if (items.length === 0) return null;
        return (
          <MenuBar
            key={menu.id}
            label={menu.label}
            trigger={menu.trigger}
            active={items.some((i) => i.isActive(active))}
            open={openMenu === menu.id}
            onToggle={() => setOpenMenu((m) => (m === menu.id ? null : menu.id))}
            onClose={closeMenu}
            onUnpinDrop={(id) => {
              if (TOOLBAR_ITEMS.some((i) => i.id === id)) unpinItem(id as ToolbarItemId);
            }}
          >
            {items.map((item) => (
              <Btn
                key={item.id}
                label={`${item.label} (drag out to pin)`}
                active={item.isActive(active)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TOOLPIN_MIME, `menu:${item.id}`);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => {
                  item.run(chain()).run();
                  closeMenu();
                }}
              >
                {item.icon}
              </Btn>
            ))}
          </MenuBar>
        );
      })}

      <span className="toolbar__sep" />

      <Btn
        label="Focus this line"
        active={!!active.focusableLine?.focused}
        disabled={!active.focusableLine}
        onClick={focusCurrentLine}
      >
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="9" r="6.75" />
          <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
          <path d="M9 1v2.5M9 14.5V17M1 9h2.5M14.5 9H17" />
        </svg>
      </Btn>

      {showTasks && (
        <>
          <span className="toolbar__sep" />

          <Btn
            label="Add selected lines to tasks"
            disabled={!active.hasSelection}
            onClick={addSelectionAsTasks}
          >
            <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="9" r="6.75" />
              <path d="M9 5.2V9l2.6 1.6" />
            </svg>
          </Btn>
        </>
      )}

      {pinned.length > 0 && (
        <>
          <span className="toolbar__sep" />
          {pinned.map((id) => {
            const item = TOOLBAR_ITEMS.find((i) => i.id === id);
            if (!item) return null;
            return (
              <Btn
                key={item.id}
                label={`${item.label} (drag away to unpin)`}
                active={item.isActive(active)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TOOLPIN_MIME, `pinned:${item.id}`);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={(e) => {
                  if (e.dataTransfer.dropEffect === "none") unpinItem(item.id);
                }}
                onClick={() => item.run(chain()).run()}
              >
                {item.icon}
              </Btn>
            );
          })}
        </>
      )}
    </div>
  );
}

export const LINE_DRAG_MIME = "application/x-focusbox-line";

export default function Notes({ doc, onChange, onAddTasks, onEditorReady, onLineDragChange, onFocusLine, showTasks, focusDone }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      FocusedLine,
      Placeholder.configure({
        placeholder:
          "Start writing…  Use the bar above, or type “# ”, “- ”, “[ ] ” for instant formatting.",
      }),
    ],
    content: doc ?? "",
    onUpdate: ({ editor }) => onChange(editor.getJSON() as NotesDoc),
  });
  const [handleTop, setHandleTop] = useState<number | null>(null);
  const hoveredLi = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Apply an EXTERNAL doc change (e.g. notes pulled from another device by cloud
  // sync) into the editor. Skip while the editor is focused so we never clobber
  // what the user is actively typing — their version is the source of truth then,
  // and LWW/conflict-copy handles the divergence. emitUpdate:false avoids a feedback
  // loop back through onUpdate.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const incoming = doc == null ? null : JSON.stringify(doc);
    const current = editor.isEmpty ? null : JSON.stringify(editor.getJSON());
    if (incoming === current) return;
    editor.commands.setContent(doc ?? "", { emitUpdate: false });
  }, [doc, editor]);

  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  // Track which draggable line the pointer is over; position the handle beside it.
  function onMouseMove(e: React.MouseEvent) {
    const li = (e.target as HTMLElement).closest?.(
      'ul[data-type="taskList"] > li, ul:not([data-type="taskList"]) > li',
    ) as HTMLElement | null;
    // Exclude ordered lists implicitly (selector matches ULs only).
    if (li && scrollRef.current?.contains(li)) {
      hoveredLi.current = li;
      const box = li.getBoundingClientRect();
      const host = scrollRef.current.getBoundingClientRect();
      setHandleTop(box.top - host.top + scrollRef.current.scrollTop);
    } else {
      if ((e.target as HTMLElement).closest?.(".line-handle")) return;
      hoveredLi.current = null;
      setHandleTop(null);
    }
  }
  function onMouseLeave() {
    hoveredLi.current = null;
    setHandleTop(null);
  }

  function onHandleDragStart(e: React.DragEvent) {
    const li = hoveredLi.current;
    const view = editor?.view;
    if (!li || !view) return;
    // posAtDOM(li, 0) = position at the start of the li's content; the node
    // itself starts one position earlier.
    const pos = view.posAtDOM(li, 0) - 1;
    e.dataTransfer.setData(LINE_DRAG_MIME, String(pos));
    e.dataTransfer.effectAllowed = "copy";
    onLineDragChange(true);
  }
  function onHandleDragEnd() {
    onLineDragChange(false);
  }

  return (
    <section className={`notes${focusDone ? " notes--focus-done" : ""}`}>
      <Toolbar editor={editor} onAddTasks={onAddTasks} onFocusLine={onFocusLine} showTasks={showTasks} />
      <div
        className="notes__scroll"
        ref={scrollRef}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onScroll={() => {
          hoveredLi.current = null;
          setHandleTop(null);
        }}
      >
        <EditorContent editor={editor} className="notes__editor" />
        {handleTop !== null && (
          <button
            type="button"
            className="line-handle"
            style={{ top: handleTop }}
            aria-label="Drag line to focus"
            title="Drag under the timer to focus on this task"
            draggable
            onDragStart={onHandleDragStart}
            onDragEnd={onHandleDragEnd}
            onMouseDown={(e) => e.preventDefault()} // don't steal editor focus
          >
            ⠿
          </button>
        )}
      </div>
    </section>
  );
}
