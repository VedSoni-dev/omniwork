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
- **Cowork mode** — spawn many agent sessions and run them **in parallel**, each with its own folder and task. A rail on the left shows every agent's status.
- **MCP connections** — plug in tools (filesystem, fetch, memory, git, Slack, databases…) via any stdio MCP server. Standard `mcpServers` config; add them from the UI.
- **Plugs into the web** — `web_fetch` reads pages/APIs, `open_url` opens links in your browser.
- **Token saver for Claude Code / Codex** — OmniWork is *also* an MCP server your premium agent can delegate grunt work to, so it burns **free** tokens instead of yours ([details](#use-omniwork-inside-claude-code--codex-token-saver-)).
- **Private** — everything runs locally. The gateway never phones home; your code stays on your machine.
- **Not locked in** — switch to Claude, GPT, Gemini, DeepSeek, or your own keys anytime via the gateway dashboard.
- **Open source, MIT.** Fork it, ship it, sell it.

> Design + UX inspired by [Claude Code](https://claude.com/claude-code) and the open-source
> [OpenWork](https://github.com/different-ai/openwork). Routing powered by [OmniRoute](https://github.com/diegosouzapw/OmniRoute).

## Download

Grab the installer for your OS from the [**Releases**](../../releases) page:

| OS | File | Status |
|----|------|--------|
| Windows | `OmniWork.Setup.0.1.0.exe` | ✅ [download](https://github.com/VedSoni-dev/omniwork/releases/latest) |
| macOS | `OmniWork-x.y.z.dmg` (Intel + Apple Silicon) | build from source · CI-built on request |
| Linux | `OmniWork-x.y.z.AppImage` / `.deb` | build from source · CI-built on request |

Then just open it. First launch takes ~30–60s the very first time while the gateway
runs one-time database migrations; subsequent launches are fast.

> macOS/Linux installers are produced by the release CI matrix. Until that runs for
> this repo, build them locally with `npm run dist:mac` / `npm run dist:linux` on the
> matching OS (see [Build from source](#build-from-source)).

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

## Use OmniWork *inside* Claude Code / Codex (token saver) 🪙

Don't want to fully switch? Keep your premium agent as the orchestrator and let it
**delegate the token-heavy grunt work to OmniWork's free models.** OmniWork ships an
MCP server — add it to your agent's `mcpServers` and it gains two tools:

- `delegate(task, cwd?)` — OmniWork does the subtask autonomously on free models and returns a summary + changes
- `delegate_parallel(tasks[], cwd?)` — fan a batch out to parallel free-model subagents

Your expensive model spends tokens on the hard reasoning; OmniWork burns **free** tokens
on the mechanical work, in the same project folder.

**Claude Code** — add to `.mcp.json` (or `claude mcp add`):
```json
{
  "mcpServers": {
    "omniwork": { "command": "node", "args": ["/absolute/path/to/omniwork/electron/mcp-server.js"] }
  }
}
```
Then just ask Claude Code to *"delegate writing the tests to omniwork"* and it will.

**Codex / Cursor / any MCP client** — same idea: point an `mcpServers` entry at
`node .../electron/mcp-server.js`. It speaks standard MCP over stdio. If the OmniWork
desktop app is already running, the server reuses its gateway; otherwise it boots its own.

> Env: `OMNIWORK_MODEL` to pin a model (default `auto`/free), `OMNIWORK_GATEWAY_PORT` to change the port.

## Build from source

Requires Node.js 22+ (24 recommended).

```bash
git clone https://github.com/VedSoni-dev/omniwork.git
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
