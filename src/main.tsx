import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme, getStoredMode } from "./lib/theme";
import { applyAccent, getStoredAccent } from "./lib/accent";

// Apply the saved theme + accent before first paint to avoid a flash.
applyTheme(getStoredMode());
applyAccent(getStoredAccent());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the service worker on the web only. The Tauri desktop bundle is built
// from the same `vite build`, but must NOT register a SW in its webview.
if (!("__TAURI_INTERNALS__" in window) && "serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
