# Focusbox

A minimal focus app: a **countdown timer**, a **task list** you check off, and a
clean **notes document** — and nothing else. No tracking, no analytics, no
accounts. Just the things you need to sit down and get something done.

## Features

- **Countdown timer** — set any duration (or tap a 5 / 15 / 25 / 50-minute
  preset). It shows as a ring that gently empties as your time runs down. When
  it reaches zero it pulses — quietly, no sound.
- **Task list** — jot down what you want to get done and check items off.
- **Notes** — a freeform document beside your tasks with light formatting:
  headings, bold, italic, strikethrough, bullet/numbered lists, and checklists.
  Use the toolbar or Markdown shortcuts (`# `, `- `, `1. `, `[ ] `).
- **Everything saves automatically** and stays on your machine.
- **Light & dark** themes follow your system automatically.

## Download

### Windows 11
Grab the latest `Focusbox_*_x64-setup.exe` from the
[**Releases**](https://github.com/mathiasthu/focusbox/releases) page and run it.

> The app isn't code-signed, so Windows SmartScreen may show a
> "Windows protected your PC" notice the first time. Click **More info →
> Run anyway**. (It's unsigned, not unsafe.) Windows 11 already includes the
> WebView2 runtime it needs, so there's nothing else to install.

### macOS (Apple Silicon)
Download the `Focusbox_*_aarch64.dmg` from the
[**Releases**](https://github.com/mathiasthu/focusbox/releases) page, open it,
and drag Focusbox to Applications.

> The app isn't signed/notarized, so the first launch needs a **right-click →
> Open** (then confirm), or run `xattr -cr /Applications/Focusbox.app` once.

## Built with

[Tauri 2](https://tauri.app) (Rust) · [React](https://react.dev) + TypeScript +
[Vite](https://vitejs.dev) · [TipTap](https://tiptap.dev) for the editor. One
codebase builds both the macOS and Windows apps.

## Develop / build from source

Requires [Node.js](https://nodejs.org), the [Rust toolchain](https://rustup.rs),
and the platform build tools (Xcode Command Line Tools on macOS; MSVC + WebView2
on Windows).

```bash
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # build the installable app for your OS
```

Both installers are produced in CI on every `v*` tag — see
`.github/workflows/build-apps.yml`.

## License

MIT
