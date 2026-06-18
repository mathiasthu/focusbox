import { useEffect, useRef, useState } from "react";
import {
  getSpotifyState,
  spotifyControl,
  type SpotifyState,
  type SpotifyAction,
} from "../lib/spotify";

const POLL_MS = 3000;

export default function SpotifyPlayer() {
  const [state, setState] = useState<SpotifyState>({ status: "unavailable" });
  const activeRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;

    async function tick() {
      // Stay quiet when hidden; skip if a poll is still pending (the first
      // permission prompt blocks osascript, so don't stack more behind it).
      if (document.hidden || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const next = await getSpotifyState();
        if (activeRef.current) setState(next);
      } finally {
        inFlightRef.current = false;
      }
    }

    void tick(); // immediate first read
    const id = setInterval(() => void tick(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      activeRef.current = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  async function act(action: SpotifyAction) {
    await spotifyControl(action);
    // Refresh shortly after so the play/pause icon + track catch up.
    setTimeout(async () => {
      const next = await getSpotifyState();
      if (activeRef.current) setState(next);
    }, 250);
  }

  const controllable =
    state.status === "playing" ||
    state.status === "paused" ||
    state.status === "stopped";
  const playing = state.status === "playing";

  return (
    <section className="spotify" aria-label="Spotify player">
      <div className="spotify__now">
        {controllable && state.track ? (
          <span className="spotify__track">
            {state.track}
            {state.artist && (
              <span className="spotify__artist"> · {state.artist}</span>
            )}
          </span>
        ) : state.status === "denied" ? (
          <span className="spotify__hint">
            Allow Focusbox to control Spotify in System Settings ▸ Privacy &
            Security ▸ Automation.
          </span>
        ) : (
          <span className="spotify__hint">
            {controllable
              ? "Nothing playing"
              : "Open Spotify to control playback"}
          </span>
        )}
      </div>

      <div className="spotify__controls">
        <button
          className="sp-btn"
          aria-label="Previous track"
          title="Previous"
          disabled={!controllable}
          onClick={() => act("previous")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="19 20 9 12 19 4 19 20" />
            <line x1="5" y1="19" x2="5" y2="5" />
          </svg>
        </button>

        <button
          className="sp-btn sp-btn--play"
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
          disabled={!controllable}
          onClick={() => act("playpause")}
        >
          {playing ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <line x1="9" y1="4" x2="9" y2="20" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          )}
        </button>

        <button
          className="sp-btn"
          aria-label="Next track"
          title="Next"
          disabled={!controllable}
          onClick={() => act("next")}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 4 15 12 5 20 5 4" />
            <line x1="19" y1="5" x2="19" y2="19" />
          </svg>
        </button>
      </div>
    </section>
  );
}
