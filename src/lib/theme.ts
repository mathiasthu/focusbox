import { isDemo } from "./demo";

export type ThemeMode = "system" | "light" | "dark";

const KEY = "focusbox-theme";

export function getStoredMode(): ThemeMode {
  if (isDemo()) return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function storeMode(mode: ThemeMode): void {
  if (isDemo()) return;
  localStorage.setItem(KEY, mode);
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

/** Set the data-theme attribute the CSS reacts to. */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(mode);
}
