import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Nudge from "./components/Nudge";
import "./styles.css";
import { applyTheme, getStoredMode } from "./lib/theme";
import { applyAccent, getStoredAccent } from "./lib/accent";

// Apply the saved theme + accent before first paint to avoid a flash.
applyTheme(getStoredMode());
applyAccent(getStoredAccent());

// The focus guard's full-screen nudge is a second window onto the same bundle
// (src-tauri/src/focusguard.rs opens it at index.html?view=nudge).
const isNudge =
  "__TAURI_INTERNALS__" in window && new URLSearchParams(window.location.search).get("view") === "nudge";
if (isNudge) document.documentElement.classList.add("nudge-root");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isNudge ? <Nudge /> : <App />}</React.StrictMode>,
);

// Register the service worker on the web only. The Tauri desktop bundle is built
// from the same `vite build`, but must NOT register a SW in its webview.
if (!("__TAURI_INTERNALS__" in window) && "serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
