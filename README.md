<div align="center">

# ◇ OmniWork

**An open-source Claude Code / Cowork-style desktop coding agent — with [OmniRoute](https://github.com/diegosouzapw/OmniRoute) baked in.**

Download it, open a folder, and start building with AI. No API keys. No config. No accounts.
The AI router ships *inside* the app, so free models work the second you launch.

[![License: MIT](https://img.shields.io/badge/License-MIT-d97757.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-2c2a27)

</div>

---

## Why

Every AI coding tool makes you bring your own keys and wire up a provider. OmniWork doesn't.
It bundles **OmniRoute** — a local AI gateway that fronts 278+ providers (90+ free) — as an
in-app sidecar. On first launch OmniWork starts the gateway on `localhost:20128`, provisions a
local key for itself, and points its agent at it. You get a working coding agent with **zero setup**.

- **Zero config** — free models (`auto` routing) work out of the box.
- **Real agent** — reads, writes, and edits files and runs commands in a workspace you choose, like Claude Code.
- **Private** — everything runs locally. The gateway never phones home; your code stays on your machine.
- **Not locked in** — switch to Claude, GPT, Gemini, DeepSeek, or your own keys anytime via the gateway dashboard.
- **Open source, MIT.** Fork it, ship it, sell it.

> Design + UX inspired by [Claude Code](https://claude.com/claude-code) and the open-source
> [OpenWork](https://github.com/different-ai/openwork). Routing powered by [OmniRoute](https://github.com/diegosouzapw/OmniRoute).

## Download

Grab the installer for your OS from the [**Releases**](../../releases) page:

| OS | File |
|----|------|
| Windows | `OmniWork-Setup-x.y.z.exe` |
| macOS | `OmniWork-x.y.z.dmg` (Intel + Apple Silicon) |
| Linux | `OmniWork-x.y.z.AppImage` / `.deb` |

Then just open it. First launch takes a few seconds while the gateway warms up.

## How it works

```
┌─ OmniWork (Electron desktop app) ───────────────────────────┐
│                                                             │
│  Renderer (Claude Code / Cowork-style UI)                   │
│        │  IPC                                                │
│  Main process                                               │
│    ├─ Agent loop  ── OpenAI-compatible ──┐                  │
│    └─ spawns OmniRoute sidecar           │                  │
│         (localhost:20128, free models)  ◄┘                  │
└───────────────────────────┬─────────────────────────────────┘
                            │
              OmniRoute ──► 278+ providers (free tier by default)
```

1. On boot, `electron/sidecar.js` spawns the bundled `omniroute` binary using Electron's own
   Node runtime (`ELECTRON_RUN_AS_NODE`), so no separate Node install is needed.
2. It health-checks `http://localhost:20128/v1` and reports status in the sidebar.
3. `electron/agent.js` runs a tool-use loop against that endpoint with the model set to `auto`.
4. Tools (`electron/tools.js`) are confined to the workspace folder you pick.

## Build from source

Requires Node.js 22+ (24 recommended).

```bash
git clone https://github.com/YOUR_USERNAME/omniwork.git
cd omniwork
npm install          # pulls Electron + bundles OmniRoute
npm start            # run the app
```

Package installers:

```bash
npm run dist:win     # Windows NSIS installer
npm run dist:mac     # macOS dmg
npm run dist:linux   # AppImage + deb
```

Output lands in `dist/`.

## Configuration

OmniWork works with no configuration. To go beyond the free tier:

1. Click **Gateway dashboard ↗** in the sidebar (opens OmniRoute at `localhost:20128`).
2. Add provider API keys there (Claude, OpenAI, etc.) — stored encrypted, locally.
3. Pick a specific model in the top bar, or leave it on `auto` for smart free routing.

Environment overrides (optional):

| Var | Default | Purpose |
|-----|---------|---------|
| `OMNIWORK_GATEWAY_PORT` | `20128` | Port for the bundled gateway |
| `OMNIWORK_WORKSPACE` | — | Start with a specific workspace folder |
| `OMNIWORK_DEV` | — | Open devtools + verbose gateway logs |

## Project layout

```
electron/
  main.js       app lifecycle, windows, IPC
  sidecar.js    bundled OmniRoute process manager  ← the core idea
  agent.js      OpenAI-compatible tool-use loop
  tools.js      file + shell tools (workspace-confined)
  preload.js    contextIsolation-safe IPC bridge
renderer/
  index.html    UI markup
  styles.css    Claude Code / Cowork-style theme
  app.js        UI logic
```

## Contributing

PRs welcome. This is meant to be a clean, hackable base. Good first issues: streaming token
output, session history, MCP tool support, diff previews before writes.

## License

MIT © OmniWork contributors. OmniRoute is MIT © its authors.
