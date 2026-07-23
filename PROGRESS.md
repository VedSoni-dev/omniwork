# OmniWork — build progress

Autonomous build log (loop mode). Newest status at top.

## Status: CORE WORKING · packaging in validation

### Proven working ✅
- **End-to-end smoke test passes**: bundled-Node gateway boots (~11s cold) → agent
  tool loop → real file written → free model, zero keys, zero config.
- OmniRoute serves 99 models on `auto` out of the box with no API key (localhost open).
- Tool-calling confirmed against the free `auto` model.

### Done
- [x] Electron app scaffold (main, preload, sidecar, agent, tools)
- [x] Claude Code / Cowork-style renderer UI
- [x] **Sidecar** spawns OmniRoute `dist/server.js` (Next standalone) — the core idea
- [x] Key finding: Electron's embedded Node can't boot the Next server → **bundle a real
      Node binary** via `beforePack` hook (scripts/stage-node.js) + spawn gateway with it
- [x] `stream:false` fix (gateway defaults to SSE)
- [x] App icon generated dependency-free (scripts/gen-icon.js → assets/icon.png)
- [x] `npmRebuild:false` (we don't run native under Electron; avoids gyp/distutils failure)
- [x] CI workflow (boot check) + Release workflow (win/mac/linux matrix → GitHub Release)
- [x] README, LICENSE (MIT), test scripts

### In progress
- [ ] `electron-builder --dir` packaging validation (verify runtime/ + omniroute unpacked)
- [ ] Launch the *packaged* app and confirm gateway boots from bundled node
- [ ] Full NSIS installer build

### Next
- [ ] Push to GitHub, tag v0.1.0, let Actions build installers
- [ ] Final polish: streaming tokens, session history (nice-to-have)

### Key facts learned about OmniRoute
- Bare `omniroute` = `serve` (default cmd) → supervisor that spawns `node dist/server.js`.
  We bypass the supervisor (it needs `node` on PATH) and spawn `dist/server.js` ourselves.
- Data dir env is **`DATA_DIR`** (win default: `%APPDATA%/omniroute`).
- `/v1` on localhost needs **no auth** on fresh install. `model:"auto"` → free provider.
- `dist/server.js` = Next.js standalone (CommonJS, reads `PORT`/`HOSTNAME`).
- Needs Node 22+ (uses APIs missing in Electron 33's Node 20).
