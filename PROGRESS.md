# OmniWork — build progress

## Status: ✅ SHIPPED — v0.1.2 (Claude Code terminal look)

- **Repo:** https://github.com/VedSoni-dev/omniwork (public, MIT)
- **Latest release:** https://github.com/VedSoni-dev/omniwork/releases/tag/v0.1.2
  - `OmniWork.Setup.0.1.2.exe` (~317 MB) — Windows installer

### Delivered
- [x] Electron app, OmniRoute bundled as in-app sidecar (zero setup, free models, no keys)
- [x] Bundled real Node runtime to run the gateway
- [x] Real coding agent: read/write/edit/run, workspace-confined
- [x] **Codex-style UI (v0.1.1)**: file explorer tree + folder picker, file viewer tabs,
      @-file mentions w/ autocomplete, diff-styled tool cards, shadcn zinc design system
- [x] Validated: faithful design preview + live Electron boot (gateway 1s, no renderer errors)
- [x] Windows installer built + released; repo pushed

### Needs the user
- **GitHub Actions billing lock** → macOS/Linux auto-build blocked. Build from source
  (`npm run dist:mac` / `dist:linux`) until resolved; then a tag auto-builds all 3 OSes.
- Installer ~317 MB (OmniRoute bundles a full Next.js server) — inherent, one-time download.

### Next ideas
- Streaming token output, session history, richer diffs, MCP tools, size trim.
