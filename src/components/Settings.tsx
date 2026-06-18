import { useEffect, type CSSProperties } from "react";
import type { ThemeMode } from "../lib/theme";
import { ACCENTS, type AccentId } from "../lib/accent";
import { SUPPORT_URL, APP_VERSION } from "../lib/config";

async function openExternal(url: string) {
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

const MODES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  accent: AccentId;
  onAccentChange: (id: AccentId) => void;
  playerVisible: boolean;
  onPlayerVisibleChange: (visible: boolean) => void;
}

export default function Settings({
  open,
  onClose,
  themeMode,
  onThemeChange,
  accent,
  onAccentChange,
  playerVisible,
  onPlayerVisibleChange,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">Settings</h2>
          <button className="modal__close" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="setting">
          <span className="setting__label">Appearance</span>
          <div className="segmented" role="group" aria-label="Theme">
            {MODES.map((m) => (
              <button
                key={m.value}
                className={`segmented__opt${themeMode === m.value ? " segmented__opt--active" : ""}`}
                aria-pressed={themeMode === m.value}
                onClick={() => onThemeChange(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting">
          <span className="setting__label">Accent</span>
          <div className="swatches" role="group" aria-label="Accent color">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`swatch${accent === a.id ? " swatch--active" : ""}`}
                style={{ "--swatch": a.swatch } as CSSProperties}
                aria-label={a.label}
                aria-pressed={accent === a.id}
                title={a.label}
                onClick={() => onAccentChange(a.id)}
              />
            ))}
          </div>
        </div>

        <div className="setting">
          <span className="setting__label">Spotify player</span>
          <div className="segmented" role="group" aria-label="Spotify player">
            <button
              type="button"
              className={`segmented__opt${playerVisible ? " segmented__opt--active" : ""}`}
              aria-pressed={playerVisible}
              onClick={() => onPlayerVisibleChange(true)}
            >
              On
            </button>
            <button
              type="button"
              className={`segmented__opt${!playerVisible ? " segmented__opt--active" : ""}`}
              aria-pressed={!playerVisible}
              onClick={() => onPlayerVisibleChange(false)}
            >
              Off
            </button>
          </div>
        </div>

        <div className="setting setting--col">
          <span className="setting__label">Enjoying Focusbox?</span>
          <button className="support" onClick={() => openExternal(SUPPORT_URL)}>
            <span className="support__heart">♥</span> Support Focusbox
          </button>
          <span className="setting__hint">
            It's free and open source — support is optional and always appreciated.
          </span>
        </div>

        <p className="modal__foot">Focusbox v{APP_VERSION}</p>
      </div>
    </div>
  );
}
