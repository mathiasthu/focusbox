import { isDemo } from "./demo";

export type AccentId =
  | "clay"
  | "blue"
  | "red"
  | "teal"
  | "gold"
  | "indigo"
  | "graphite";

const KEY = "focusbox-accent";

export interface AccentOption {
  id: AccentId;
  label: string;
  /** Representative dot color for the picker (the light-mode accent). */
  swatch: string;
}

export const ACCENTS: AccentOption[] = [
  { id: "clay", label: "Clay", swatch: "#bf5a2f" },
  { id: "red", label: "Brick", swatch: "#a83c32" },
  { id: "blue", label: "Slate", swatch: "#4a6d99" },
  { id: "teal", label: "Teal", swatch: "#3f7d78" },
  { id: "gold", label: "Ochre", swatch: "#96721f" },
  { id: "indigo", label: "Indigo", swatch: "#5b5a94" },
  { id: "graphite", label: "Graphite", swatch: "#5b6068" },
];

const IDS: AccentId[] = [
  "clay",
  "red",
  "blue",
  "teal",
  "gold",
  "indigo",
  "graphite",
];

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
