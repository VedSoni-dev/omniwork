# OmniWork v0.9.0 — Lite installer

## New: a smaller download

Two installers now:

| Build | Download | First launch |
|-------|----------|--------------|
| **Full** (`OmniWork.Setup.0.9.0.exe`) | ~317 MB | fast |
| **Lite** (`OmniWork-Lite-Setup-0.9.0.exe`) | **~192 MB** | downloads the engine once (~1–3 min, with a progress bar), then fast forever |

The lite build ships without the bundled AI engine and fetches it on first run into the
app's data folder. Same app, same features — just a lighter initial download. Pick whichever
you prefer; both are on this release.

## Everything in OmniWork
Cowork (parallel sessions) · Agent Deck (subagents) · MCP gallery · delegate-to-Claude-Code ·
streaming · approvals (with diffs) · undo · project memory (AGENTS.md) · dynamic model list ·
recipes · image paste · session persistence · web tools. Free, local, zero setup. MIT.

## Install
- **Full — Windows:** `OmniWork.Setup.0.9.0.exe`
- **Lite — Windows:** `OmniWork-Lite-Setup-0.9.0.exe`
- **macOS / Linux:** build from source (`npm run dist:mac` / `dist:linux`, or `dist:lite`).

Verified: the lite app downloads + extracts the engine on a fresh profile and boots the gateway.
