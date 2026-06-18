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
