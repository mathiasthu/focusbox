# CLAUDE.md — Focusbox

Guidance for any agent (Claude Code or otherwise) working in this repo.

## Read first

**Read `HANDOFF.md` before doing any work.** It is the living source of truth for what this project is, the locked behavior decisions, the structure, and the current state.

## Mandatory workflow rule

**Every change must update `HANDOFF.md` and be committed before the task is done.**

1. Make your change.
2. Update `HANDOFF.md`: reflect new behavior/decisions, structure changes, the "Current state" section, and add a dated line to the Changelog.
3. Commit code + updated `HANDOFF.md` together with a clear message.

Never finish a task leaving uncommitted changes or a stale handoff. This guarantees the next agent inherits full, current context.

## What this is

A deliberately minimal focus app: a countdown timer + a checkable task list, with a clean markdown-notes document beside them. macOS now (Tauri), Windows later from the same code. See `HANDOFF.md` for full detail.

## Common commands

```bash
npm run tauri dev      # dev with hot reload
npm run tauri build    # production .app + .dmg
npx tsc --noEmit       # type-check frontend
```

## Conventions

- Keep it minimal — resist scope creep (no analytics, accounts, sync, sound/notifications, multiple notes). Anything new is a deliberate decision recorded in `HANDOFF.md`.
- App logic lives in the React frontend; keep the Rust side near-default.
- Don't commit build artifacts — `target/`, `node_modules/`, `dist/` are gitignored.
