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

- **NordVPN blanks the app (recurring "app doesn't load" / white window).** NordVPN's
  ad-block/tracker/URL-cleaning (Shield endpoint-security extension) hangs WKWebView
  page loads for non-Apple (ad-hoc-signed) apps — Tauri dev AND release builds show a
  blank white window; Safari/curl work fine, so it looks like a code bug. Diagnose:
  minimal compiled WKWebView probe loading `http://localhost:<port>` times out while
  `http://127.0.0.1:<port>` renders. Fix: quit NordVPN (`osascript -e 'tell application
  "NordVPN" to quit'`) — instant recovery — or reboot if its system extension is
  half-updated (`systemextensionsctl list` shows one "waiting to uninstall on reboot").
  This, not zombie processes, was the 2026-07-13 root cause; check it FIRST when the
  window opens but stays white.

- **Launching the desktop app (`npm run tauri dev`): kill ALL zombies first.**
  The single-instance plugin makes any surviving Focusbox process (installed
  app, `target/release/bundle` binary, prior dev run) swallow the new launch —
  the fresh binary focuses the zombie and exits. A zombie vite on :1420 also
  kills `beforeDevCommand`. Run:
  `pkill -f "tauri dev"; pkill -f "node_modules/.bin/vite"; pkill -f "target/debug/focusbox"; pkill -f "target/release/bundle/macos/Focusbox"`
  then launch and confirm `pgrep -f target/debug/focusbox` stays alive.
- zsh: never `echo ===` in Bash tool commands (`=`-prefixed words trigger
  zsh command-path expansion and abort the chain); quote or use `---`.

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
- **Direct TipTap handle:** `document.querySelector('.notes__editor .ProseMirror').editor`
  is the live Editor instance — `editor.commands.setContent(json, { emitUpdate: true })`
  is the reliable way to seed exact note structures (execCommand + toolbar clicks in the
  same evaluate tick race React re-renders and interleave text).
- Focus-task feature selectors (2026-07): drag handle is `.line-handle` (appears on
  `mousemove` over bullet/checklist `li`, hides over other content and on scroll), drop
  target `.focus-slot`, card `.focus-card` (+`--done`), highlighted line
  `li[data-focused="true"]`. Same synthesized-drag recipe as `.note-promote` above.
