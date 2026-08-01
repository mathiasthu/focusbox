import { useEffect, type CSSProperties } from "react";
import type { ThemeMode } from "../lib/theme";
import { ACCENTS, type AccentId } from "../lib/accent";
import { SUPPORT_URL, SUPPORT_EMAIL, APP_VERSION } from "../lib/config";
import { isSpotifyAvailable } from "../lib/spotify";
import { isTrayAvailable } from "../lib/tray";
import { isAutostartAvailable } from "../lib/autostart";
import { playChime, SOUNDS, type SoundId } from "../lib/chime";
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
  showTasks: boolean;
  onShowTasksChange: (visible: boolean) => void;
  menubarTimer: boolean;
  onMenubarTimerChange: (visible: boolean) => void;
  chime: boolean;
  onChimeChange: (enabled: boolean) => void;
  chimeSound: SoundId;
  onChimeSoundChange: (id: SoundId) => void;
  autostart: boolean;
  onAutostartChange: (enabled: boolean) => void;
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
  showTasks,
  onShowTasksChange,
  menubarTimer,
  onMenubarTimerChange,
  chime,
  onChimeChange,
  chimeSound,
  onChimeSoundChange,
  autostart,
  onAutostartChange,
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

        <div className="setting">
          <span className="setting__label">Show tasks</span>
          <div className="segmented" role="group" aria-label="Show tasks">
            <button
              type="button"
              className={`segmented__opt${showTasks ? " segmented__opt--active" : ""}`}
              aria-pressed={showTasks}
              onClick={() => onShowTasksChange(true)}
            >
              On
            </button>
            <button
              type="button"
              className={`segmented__opt${!showTasks ? " segmented__opt--active" : ""}`}
              aria-pressed={!showTasks}
              onClick={() => onShowTasksChange(false)}
            >
              Off
            </button>
          </div>
        </div>

        <div className="setting">
          <span className="setting__label">Timer sound</span>
          <div className="segmented" role="group" aria-label="Timer sound">
            <button
              type="button"
              className={`segmented__opt${chime ? " segmented__opt--active" : ""}`}
              aria-pressed={chime}
              onClick={() => {
                onChimeChange(true);
                playChime(chimeSound); // preview, so the choice is audible right away
              }}
            >
              On
            </button>
            <button
              type="button"
              className={`segmented__opt${!chime ? " segmented__opt--active" : ""}`}
              aria-pressed={!chime}
              onClick={() => onChimeChange(false)}
            >
              Off
            </button>
          </div>
        </div>

        {/* Only worth showing once the sound is on — five options is a lot of modal
            to spend on a setting that's currently doing nothing. */}
        {chime && (
          <div className="setting setting--col">
            <span className="setting__label">Sound</span>
            <div className="soundpicker" role="group" aria-label="Sound">
              {SOUNDS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`soundopt${chimeSound === s.id ? " soundopt--active" : ""}`}
                  aria-pressed={chimeSound === s.id}
                  onClick={() => {
                    onChimeSoundChange(s.id);
                    playChime(s.id); // preview the one just picked
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <span className="setting__hint">Pick one to hear it.</span>
          </div>
        )}

        {isTrayAvailable && (
          <div className="setting">
            <span className="setting__label">Menubar timer</span>
            <div className="segmented" role="group" aria-label="Menubar timer">
              <button
                type="button"
                className={`segmented__opt${menubarTimer ? " segmented__opt--active" : ""}`}
                aria-pressed={menubarTimer}
                onClick={() => onMenubarTimerChange(true)}
              >
                On
              </button>
              <button
                type="button"
                className={`segmented__opt${!menubarTimer ? " segmented__opt--active" : ""}`}
                aria-pressed={!menubarTimer}
                onClick={() => onMenubarTimerChange(false)}
              >
                Off
              </button>
            </div>
          </div>
        )}

        {/* Desktop only. Unlike the rows above, this one isn't synced — it registers
            a login item on THIS machine (see autostart.ts), hence the hint. */}
        {isAutostartAvailable && (
          <div className="setting setting--col">
            <div className="setting__row">
              <span className="setting__label">Start on login</span>
              <div className="segmented" role="group" aria-label="Start on login">
                <button
                  type="button"
                  className={`segmented__opt${autostart ? " segmented__opt--active" : ""}`}
                  aria-pressed={autostart}
                  onClick={() => onAutostartChange(true)}
                >
                  On
                </button>
                <button
                  type="button"
                  className={`segmented__opt${!autostart ? " segmented__opt--active" : ""}`}
                  aria-pressed={!autostart}
                  onClick={() => onAutostartChange(false)}
                >
                  Off
                </button>
              </div>
            </div>
            <span className="setting__hint">
              Opens Focusbox when you sign in to this computer. Applies to this device only.
            </span>
          </div>
        )}

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
              It's free and the code is public — support is optional and always appreciated.
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
