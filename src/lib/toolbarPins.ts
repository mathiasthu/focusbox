import { isDemo } from "./demo";

/** Ids of the 8 formatting items that live in the toolbar dropdowns. */
export type ToolbarItemId =
  | "h1"
  | "h2"
  | "bold"
  | "italic"
  | "strike"
  | "bullet"
  | "ordered"
  | "task";

const KEY = "focusbox-toolbar-pins";

/** Max simultaneously pinned buttons — keeps the toolbar overflow-proof. */
export const MAX_PINS = 2;

const IDS: ToolbarItemId[] = [
  "h1",
  "h2",
  "bold",
  "italic",
  "strike",
  "bullet",
  "ordered",
  "task",
];

function isItemId(v: unknown): v is ToolbarItemId {
  return typeof v === "string" && (IDS as string[]).includes(v);
}

/** Pinned toolbar items, oldest first. Unknown/duplicate ids are dropped,
 * result truncated to MAX_PINS; corrupt storage reads as no pins. */
export function getPinned(): ToolbarItemId[] {
  if (isDemo()) return [];
  const raw = localStorage.getItem(KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: ToolbarItemId[] = [];
  for (const v of parsed) {
    if (isItemId(v) && !ids.includes(v)) ids.push(v);
  }
  return ids.slice(0, MAX_PINS);
}

export function storePinned(ids: ToolbarItemId[]): void {
  if (isDemo()) return;
  localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX_PINS)));
}
