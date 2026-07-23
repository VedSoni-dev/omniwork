# OmniWork — build progress

Autonomous build log (loop mode). Newest status at top.

## Status: SCAFFOLD COMPLETE, awaiting first run

### Done
- [x] Project init, git, .gitignore
- [x] `package.json` — Electron app + electron-builder config (win/mac/linux targets)
- [x] `electron/sidecar.js` — spawns bundled OmniRoute as child process, health-checks, auto API key
- [x] `electron/agent.js` — OpenAI-compatible tool-use agent loop against local gateway
- [x] `electron/tools.js` — list_dir/read_file/write_file/edit_file/run_command, workspace-confined
- [x] `electron/main.js` — app lifecycle, IPC, workspace picker, model select
- [x] `electron/preload.js` — contextIsolation-safe bridge
- [x] `renderer/` — Claude Code / Cowork-style dark UI (index.html, styles.css, app.js)

### In progress / next
- [ ] `npm install omniroute` finishing (large: Next 16 + native sqlite)
- [ ] Install electron + electron-builder devDeps
- [ ] Verify omniroute sidecar env-var names for data dir + API key (inspect bin/src)
- [ ] First launch: confirm gateway boots + health check passes on Windows
- [ ] Smoke test: send a prompt, confirm free model responds + a tool runs
- [ ] App icons (assets/)
- [ ] README with install/download instructions
- [ ] LICENSE (MIT)
- [ ] GitHub Actions release workflow (build installers for 3 OSes)
- [ ] Tag + first release

### Open questions to resolve by inspecting node_modules/omniroute
1. Does `/v1` require auth by default, or is fresh install open? (drives whether our seeded key matters)
2. Exact env var for data dir + port (README says PORT=20128; confirm OMNIROUTE_* names)
3. Whether free providers (OpenCode Free, Felo) work headless with no key

### Architecture note
Chose a lean purpose-built Electron app over hard-forking the OpenWork enterprise
monorepo (2928 files, Docker/MySQL/bun/enterprise). OpenWork kept as UX reference only.
The novel bit — OmniRoute bundled as an in-app sidecar so users need zero setup — is fully ours.
