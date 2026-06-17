# Focusbox — Handoff

> **Living document.** This is the single source of truth for project context.
> **Every change to the project MUST update this file and be committed** (see "Workflow rule" below).
> Read this top-to-bottom before doing any work so you have full context.

## What this is

A minimal "Rize alternative": a focus app stripped to two things — a **countdown timer you set** and a **task list you check off** — plus a clean **notes document** on the right. No time-tracking, no analytics, no accounts. Deliberately small.

Runs as a native **macOS** desktop app now; same codebase builds a **Windows** app later with no code changes.

## Stack

| Layer | Choice |
|---|---|
| Shell | **Tauri 2** (Rust) — builds macOS `.app`/`.dmg` and (later) Windows `.exe`/`.msi` |
| UI | **Vite + React + TypeScript** |
| Editor | **TipTap v2** — `StarterKit` + `TaskList`/`TaskItem` (checkboxes) + `Placeholder` |
| Persistence | **`@tauri-apps/plugin-store`** → JSON file `focusbox.json` in the app config dir |
| Styling | Hand-written `src/styles.css`, CSS variables, follows system light/dark |

Rust backend is intentionally near-default — all app logic lives in the frontend.

## Behavior decisions (locked, from the original interview)

- **Timer:** countdown you set (editable mm:ss + 5/15/25-min preset chips; Start/Pause/Reset).
- **Timer end:** **visual only** — the readout pulses in the accent color. No sound, no system notification.
- **Timer ↔ tasks:** fully independent. Timer does **not** log time against tasks.
- **Tasks:** add (input + Enter), toggle done (checkbox + strikethrough), delete (hover ×). Persisted.
- **Notes:** one persistent freeform doc. Markdown shortcuts: `# ` heading, `- ` bullet, `1. ` numbered, `[ ] ` checkbox, `**bold**`/`*italic*`. No colors/tables/images.
- **Layout:** single resizable window. Left column = timer (top) + task list (below). Right pane = notes doc.

## Project structure

```
~/focusbox/
  CLAUDE.md             # project rules for agents (READ FIRST)
  HANDOFF.md            # this file
  index.html            # title "Focusbox"
  src/
    main.tsx            # imports styles.css, mounts App
    App.tsx             # owns tasks + notesDoc state; hydrates + persists; 2-pane layout
    styles.css          # all styling (light/dark)
    components/
      Timer.tsx         # countdown; visual-only finish (.timer--finished pulse)
      TaskList.tsx      # add / toggle / delete
      Notes.tsx         # TipTap editor, single persisted doc
    lib/
      store.ts          # loadState() + debounced saveState() via plugin-store
  src-tauri/
    tauri.conf.json     # window: "Focusbox", 960x600, min 720x480
    capabilities/default.json  # includes "store:default" permission
    src/lib.rs          # registers opener + store plugins
    Cargo.toml          # tauri-plugin-store added
```

Note: `src/App.css` and `src/assets/` are leftover scaffold files, currently unused (safe to delete later).

## How to run

```bash
cd ~/focusbox
npm install                # first time / after dep changes
npm run tauri dev          # dev with hot reload
npm run tauri build        # production .app + .dmg (output under src-tauri/target/release/bundle/)
npx tsc --noEmit           # frontend type-check
```

Prerequisites: Node, Rust toolchain (`rustup`), Xcode Command Line Tools. All present on the current machine.

## Current state (2026-06-17)

- Initial version complete and committed.
- Verified: `tsc --noEmit` clean; `npm run tauri build` succeeds → `Focusbox.app` + 3.2 MB `Focusbox_0.1.0_aarch64.dmg`; app launches and runs.
- **Not yet hand-verified by clicking** in the native window: live countdown tick, task checkboxes, markdown shortcuts, persistence across relaunch. (Build/launch/typecheck are machine-verified.)
- Windows build: deferred, but no macOS-only APIs are used.

## Workflow rule (MANDATORY)

Every change to this project must, before the task is considered done:

1. **Update `HANDOFF.md`** — reflect what changed: new behavior/decisions, structure changes, current state, and anything the next agent needs.
2. **Commit** the change (code + updated HANDOFF.md together) with a clear message.

This keeps every agent working with full, current context. Do not leave uncommitted changes or a stale handoff at the end of a task.

## Changelog

- **2026-06-17** — Initial build: Tauri 2 + React/TS scaffold, Timer / TaskList / Notes components, plugin-store persistence, light/dark styling. Production build verified.
