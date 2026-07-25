# OmniWork — build progress

## Status: ✅ SHIPPED — v0.9.1

- **Repo:** https://github.com/VedSoni-dev/omniwork (public, MIT)
- **Latest:** https://github.com/VedSoni-dev/omniwork/releases/tag/v0.9.1
  - `OmniWork-0.9.1-arm64.dmg` (macOS, Apple Silicon) — first shipped Mac build
- **v0.9.0:** `OmniWork.Setup.0.9.0.exe` (318 MB, full) · `OmniWork-Lite-Setup-0.9.0.exe` (136 MB)

### v0.9.1 — macOS support
- [x] Gateway survives window close on macOS (was: dock reopen hit a dead engine)
- [x] Clean shutdown on SIGTERM/SIGINT/SIGHUP — no more gateway orphaned on port 20128
- [x] Gateway spawned detached + killed by process group; adopts an already-running instance
- [x] PATH repair for Finder/Dock launches (`electron/shell-path.js`) — `npx` MCP servers work
- [x] Traffic lights no longer overlap the rail (hiddenInset titlebar inset + drag region)
- [x] CSP allows `data:` images — pasted-image thumbnails render
- [x] Sessions saved synchronously on quit (debounced timer never fired)
- [x] Model picker repopulates when the gateway becomes ready (was stuck at 5 entries)
- [x] `run_command` uses the user's login shell; `open_url` works outside Electron
- [x] `npm run doctor` — verifies setup, repairs a half-extracted Electron binary
- [x] `stage-node` warns on cross-arch builds instead of shipping an unrunnable Node

### Delivered (v0.9.0)
- [x] OmniRoute bundled as in-app sidecar (zero setup, free models, no keys)
- [x] Claude Code terminal UI (streaming ⚡, ⏺/⎿ tools, ✻ thinking, > prompt)
- [x] Coding agent: read/write/edit/run + web_fetch/open_url, workspace-confined
- [x] Cowork (parallel sessions) · Agent Deck (parallel subagents)
- [x] MCP connections (one-click gallery) · delegate MCP server for Claude Code/Codex
- [x] Approval mode (with diffs) · undo · slash commands · session persistence
- [x] Project memory (AGENTS.md) · dynamic model list · recipes · image paste
- [x] Lite installer (downloads engine on first run; auto-copies platform sqlite)
- [x] Tests: cowork, features (stream/undo/approval), persist, polish; MCP client + server verified
- [x] Pro README with SVG demo

### Needs the user
- GitHub Actions billing lock → mac/Linux auto-build blocked (build from source meanwhile)

### Roadmap left (not built)
- Distribution: code-signing, demo video, Show HN / Reddit / PH launch, winget/brew
