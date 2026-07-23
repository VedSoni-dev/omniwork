# OmniWork — build progress

## Status: ✅ SHIPPED — v0.1.0

- **Repo:** https://github.com/VedSoni-dev/omniwork (public, MIT)
- **Release:** https://github.com/VedSoni-dev/omniwork/releases/tag/v0.1.0
  - `OmniWork.Setup.0.1.0.exe` (318 MB) — Windows installer, downloadable now

### Delivered
- [x] Electron desktop app, Claude-Code / Cowork-style UI
- [x] **OmniRoute bundled + auto-started** as an in-app sidecar (the core idea) — zero setup
- [x] Bundled real Node runtime to run the gateway (Electron's Node can't boot Next standalone)
- [x] Real coding agent: read/write/edit files + run commands, workspace-confined
- [x] Zero-config free models (OmniRoute `auto`, no API key)
- [x] **Validated end-to-end**: smoke test + packaged `OmniWork.exe` boot + live completion
- [x] App icon, README, CONTRIBUTING, LICENSE, tests, CI + release workflows
- [x] Windows installer built + attached to GitHub Release

### Known limitations / needs the user
- **GitHub Actions is blocked by a billing lock on the account** → multi-OS auto-build
  can't run. Windows installer built locally + uploaded manually. Resolve billing and
  the release workflow will produce macOS + Linux installers on the next tag.
- macOS / Linux: build from source for now (`npm run dist:mac` / `dist:linux`).
- Installer is ~318 MB (OmniRoute bundles a full Next.js server). Future: prune
  omniroute `.build`/`node_modules` to shrink.

### Possible next iterations
- Streaming token output in the UI, session history, diff previews before writes, MCP tools.
- Size optimization pass.
