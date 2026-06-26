import { isDemo } from "./demo";

export type AccentId = "clay" | "green" | "blue" | "plum";

const KEY = "focusbox-accent";

export interface AccentOption {
  id: AccentId;
  label: string;
  /** Representative dot color for the picker (the light-mode accent). */
  swatch: string;
}

export const ACCENTS: AccentOption[] = [
  { id: "clay", label: "Clay", swatch: "#bf5a2f" },
  { id: "green", label: "Forest", swatch: "#5f7a45" },
  { id: "blue", label: "Slate", swatch: "#4a6d99" },
  { id: "plum", label: "Plum", swatch: "#8a4a63" },
];

const IDS: AccentId[] = ["clay", "green", "blue", "plum"];

function isAccent(v: string | null): v is AccentId {
  return v !== null && (IDS as string[]).includes(v);
}

export function getStoredAccent(): AccentId {
  if (isDemo()) return "clay";
  const v = localStorage.getItem(KEY);
  return isAccent(v) ? v : "clay";
}

export function storeAccent(id: AccentId): void {
  if (isDemo()) return;
  localStorage.setItem(KEY, id);
}

/** Set the data-accent attribute the CSS reacts to. */
export function applyAccent(id: AccentId): void {
  document.documentElement.dataset.accent = id;
}
