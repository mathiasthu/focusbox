import { useEffect, type CSSProperties } from "react";
import type { ThemeMode } from "../lib/theme";
import { ACCENTS, type AccentId } from "../lib/accent";
import { SUPPORT_URL, SUPPORT_EMAIL, APP_VERSION } from "../lib/config";
import { isSpotifyAvailable } from "../lib/spotify";
import AccountSync from "./AccountSync";
import type { SyncController } from "../hooks/useSync";

function isStripeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com"));
  } catch {
    return false;
  }
}

async function openExternal(url: string) {
  if (!isStripeUrl(url)) {
    console.error("Focusbox: refusing to open a non-Stripe URL.", url);
    return;
  }
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.location.assign(url);
  }
}

// Opens the support email in the user's mail client (Tauri opener on desktop — the
// capability allows mailto: — or a normal mailto navigation in the browser). The URL is
// a fixed constant, so there's no user input to guard against here.
async function openMail() {
  const url = `mailto:${SUPPORT_EMAIL}`;
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.location.href = url;
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
  sync: SyncController;
  demo: boolean;
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
  sync,
  demo,
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

        {!demo && <AccountSync sync={sync} />}

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

        {isSpotifyAvailable && (
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
        )}

        {!demo && (
          <div className="setting setting--col">
            <span className="setting__label">Enjoying Focusbox?</span>
            <button className="support" onClick={() => openExternal(SUPPORT_URL)}>
              <span className="support__heart">♥</span> Support Focusbox
            </button>
            <span className="setting__hint">
              It's free and open source — support is optional and always appreciated.
            </span>
          </div>
        )}

        {!demo && (
          <div className="setting setting--col">
            <span className="setting__label">Help &amp; feedback</span>
            <button type="button" className="account__link" onClick={() => void openMail()}>
              {SUPPORT_EMAIL}
            </button>
            <span className="setting__hint">
              Spotted a bug or need a hand? Email me and I'll get back to you.
            </span>
          </div>
        )}

        <p className="modal__foot">Focusbox v{APP_VERSION}</p>
      </div>
    </div>
  );
}
