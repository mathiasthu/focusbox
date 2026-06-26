import type { SyncedTask } from "./syncTypes";
import type { NotesDoc } from "./store";

/** True when the app is running as the embeddable, ephemeral marketing demo
 * (`/demo` route or `?demo=1`). In demo mode: no login/sync/billing, in-memory
 * storage only, Settings is appearance-only. */
export function isDemo(): boolean {
  if (typeof window === "undefined") return false;
  const { pathname, search } = window.location;
  return pathname === "/demo" || pathname.startsWith("/demo/") ||
    new URLSearchParams(search).get("demo") === "1";
}

/** Curated sample tasks. Fresh copies each call so the in-memory demo store can
 * be mutated without leaking across reloads. */
export function demoTasks(): SyncedTask[] {
  const t = 1_700_000_000_000; // fixed base so order is stable
  return [
    { id: "demo-1", text: "Draft the quarterly plan", done: false, order: 0, updated_at: t },
    { id: "demo-2", text: "Review pull requests", done: true, order: 1, updated_at: t },
    { id: "demo-3", text: "Deep-work: write spec", done: false, order: 2, updated_at: t },
  ];
}

/** A short sample note as TipTap JSON. */
export function demoNotesDoc(): NotesDoc {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Today's focus" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "This is a live demo of Focusbox — a timer, a task list, and a quiet notes pane. " },
          { type: "text", marks: [{ type: "bold" }], text: "Nothing here is saved." },
        ],
      },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Set a timer and start a focus block." }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Tick a task off the list." }] }] },
        ],
      },
    ],
  };
}
