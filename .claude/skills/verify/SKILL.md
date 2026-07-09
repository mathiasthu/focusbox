---
name: verify
description: Runtime-verify focusbox frontend changes by driving the app in a browser via vite dev + Playwright MCP.
---

# Verifying focusbox changes

The React frontend is the whole app; Tauri adds Spotify/store/updater only. For
frontend features, drive the browser build — no need to launch the Tauri shell.

## Launch

```bash
nohup npx vite --port 5199 > "$SCRATCHPAD/vite.log" 2>&1 &   # ready in ~2s, curl / for 200
```

Then Playwright MCP: `browser_navigate` to `http://localhost:5199/`.
State persists in localStorage (`focusbox-state`), so reloads test persistence.

## Gotchas

- Console shows a `manifest.webmanifest` syntax error in dev — PWA plugin
  artifact, ignore.
- Seeding notes: `document.execCommand('insertText'/'insertParagraph')` on the
  focused `.notes__editor .ProseMirror` works; blur after so external doc
  effects apply.
- React controlled inputs (timer dial fields): set value via the native
  `HTMLInputElement.prototype.value` setter + dispatch `input`.
- The notepad gutter button `.note-promote` appears on `mousemove` over a line
  (Playwright `browser_hover` works; from `evaluate`, dispatch a bubbling
  `mousemove` on the line).
- HTML5 drag to the focus slot: Playwright `browser_drag` fails (the
  `.focus-slot` drop target only renders mid-drag and end targets resolve
  eagerly). Synthesize instead in one `evaluate`: `new DataTransfer()` →
  `dragstart` on `.note-promote` → wait 100ms → `dragover` + `drop` on
  `.focus-slot` → `dragend`.
- Timer: fastest end-to-end expiry is min=0 sec=1, Start, wait ~1.6s.
