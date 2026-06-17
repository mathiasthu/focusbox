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

- **Timer:** countdown you set (editable mm:ss + 5/15/25/50-min preset chips; Start/Pause/Reset). Shown as a **circular ring that depletes** as time runs down (the "line slowly disappears"). A status caption reads set timer / focusing / paused / time's up.
- **Timer end:** **visual only** — the readout + ring pulse in the accent color. No sound, no system notification.
- **Timer ↔ tasks:** fully independent. Timer does **not** log time against tasks.
- **Tasks:** add (input + Enter), toggle done (custom checkbox + strikethrough), delete (hover ×). Header shows "N left". Persisted.
- **Notes:** one persistent freeform doc with a **formatting toolbar pinned at the top-left** (H1, H2, bold, italic, strike, bullet, numbered, checklist) plus markdown shortcuts: `# `, `- `, `1. `, `[ ] `, `**bold**`/`*italic*`. No colors/tables/images.
- **Layout:** single resizable window, **50 / 50 split** — left half = timer (top) + task list (below); right half = notes (toolbar + editor).

## Design system ("quiet study" editorial)

- **Fonts (Google Fonts CDN, see `index.html`):** Fraunces (serif) for timer numerals, headings, wordmark; Hanken Grotesk for UI/body. Solid system fallbacks if offline — consider self-hosting/bundling later for full offline fidelity.
- **Palette:** warm paper + ink with a single burnt-clay accent (`--accent`); full light/dark via `prefers-color-scheme`. All tokens are CSS variables at the top of `src/styles.css`.
- **Touches:** depleting SVG ring (stroke-dashoffset, 1s linear transition), film-grain overlay (`body::after`), custom checkboxes, pill buttons/chips, staggered page fade-in.

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
      Timer.tsx         # countdown + depleting SVG ring; visual-only finish
      TaskList.tsx      # add / toggle / delete; "N left" header
      Notes.tsx         # TipTap editor + formatting Toolbar (top-left)
    lib/
      store.ts          # loadState() + debounced saveState(); Tauri plugin-store,
                        #   falls back to localStorage in a plain browser (dev preview)
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

- Initial version + full visual redesign complete and committed.
- The localStorage fallback means the UI now runs in a plain browser (`npm run dev` → http://localhost:1420), which was used to verify the redesign via Playwright:
  - 50/50 layout, depleting ring (confirmed receding mid-countdown), toolbar + active states, H1 via toolbar, markdown `[ ]` checkbox shortcut, task + checklist toggling/strikethrough, light **and** dark themes — all confirmed visually.
- `tsc --noEmit` clean; `npm run tauri build` succeeds → `Focusbox.app` + `Focusbox_0.1.0_aarch64.dmg`.
- Still worth a native-window eyeball: persistence across an actual app relaunch (the Tauri plugin-store path; the browser path is verified).
- Windows build: deferred, but no macOS-only APIs are used.

## Workflow rule (MANDATORY)

Every change to this project must, before the task is considered done:

1. **Update `HANDOFF.md`** — reflect what changed: new behavior/decisions, structure changes, current state, and anything the next agent needs.
2. **Commit** the change (code + updated HANDOFF.md together) with a clear message.

This keeps every agent working with full, current context. Do not leave uncommitted changes or a stale handoff at the end of a task.

## Changelog

- **2026-06-17** — Initial build: Tauri 2 + React/TS scaffold, Timer / TaskList / Notes components, plugin-store persistence, light/dark styling. Production build verified.
- **2026-06-17** — Full redesign ("quiet study" editorial): 50/50 layout, circular depleting-ring timer (+50-min preset & status caption), formatting toolbar at top of notes, Fraunces + Hanken Grotesk fonts, grain + custom checkboxes, refined light/dark. Added localStorage fallback in `store.ts` so the UI runs in a plain browser. Verified via Playwright (light + dark); production build re-verified.
