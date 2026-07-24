<div align="center">

<img src="assets/icon.png" width="76" alt="OmniWork" />

# OmniWork

**A free, local, Claude&nbsp;Code–style coding agent — with a whole AI gateway baked in.**

Download it, open a folder, and start building. No API key. No login. No config.
Free models work the second you launch — and you can run a whole *team* of agents at once.

[![License: MIT](https://img.shields.io/badge/license-MIT-d97757.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/windows%20·%20macOS%20·%20linux-2c2a27)
[![Release](https://img.shields.io/github/v/release/VedSoni-dev/omniwork?color=8bb072&label=release)](https://github.com/VedSoni-dev/omniwork/releases/latest)
![Free](https://img.shields.io/badge/free-no%20API%20key-8bb072)

<br/>

<img src="assets/demo.svg" width="820" alt="OmniWork — parallel agents, Agent Deck, MCP connections" />

</div>

---

## Why OmniWork

Every other AI coding tool makes you bring an API key, sign in, or pay per token. OmniWork
doesn't. It bundles **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** — a local AI
gateway fronting 278+ providers (90+ free) — as an in-app sidecar. On launch it starts the
gateway, points its agent at it, and you're coding with **zero setup**.

Then it goes further than a single chat agent: run **many agents in parallel**, let one agent
**fan work out to subagents**, plug in **MCP tools**, and even use OmniWork as a **token-saving
delegate** *inside* Claude Code or Codex.

## Features

| | |
|---|---|
| 🆓 **Free & keyless** | Free models via `auto` routing, out of the box. Never rate-limited (auto-fallback across providers). |
| 🖥️ **Claude Code UI** | A clean terminal: `⏺`/`⎿` tool calls, `✻` thinking, `>` prompt, `@`-file mentions. |
| 🤝 **Cowork** | Spawn many agent sessions and run them **in parallel**, each with its own folder + task. |
| 🃏 **Agent Deck** | One agent **fans work out to parallel subagents** — watch them live as a deck of cards. |
| 🔌 **MCP connections** | Plug in tools (filesystem, GitHub, Postgres, Slack…) via any stdio MCP server. Add from the UI. |
| 🪙 **Delegate tool** | OmniWork is *also* an MCP server — let Claude Code / Codex offload grunt work to its free models. |
| 🌐 **Web-aware** | `web_fetch` reads pages/APIs; `open_url` opens links in your browser. |
| 🔒 **100% local** | Everything runs on your machine. The gateway never phones home. |
| 🧩 **MIT, hackable** | Plain CommonJS, no build step for the UI. Fork it, ship it, sell it. |

## Download

Grab the installer from the [**latest release**](https://github.com/VedSoni-dev/omniwork/releases/latest):

| OS | File | Status |
|----|------|--------|
| Windows | `OmniWork.Setup.x.y.z.exe` | ✅ available |
| macOS | `.dmg` (Intel + Apple Silicon) | build from source |
| Linux | `.AppImage` / `.deb` | build from source |

Open it, pick a folder, type a task. First launch takes ~30–60s (one-time DB setup); fast after.

## Use OmniWork *inside* Claude Code / Codex — token saver 🪙

Don't want to fully switch? Keep your premium agent as the orchestrator and let it **delegate the
token-heavy grunt work to OmniWork's free models.** OmniWork ships an MCP server exposing two tools:

- `delegate(task, cwd?)` — OmniWork does the subtask autonomously on free models and returns a summary + changes
- `delegate_parallel(tasks[], cwd?)` — fan a batch out to parallel free-model subagents

Your expensive model spends tokens on the hard reasoning; OmniWork burns **free** tokens on the
mechanical work, in the same project folder.

**Claude Code** — add to `.mcp.json` (or `claude mcp add`):
```json
{
  "mcpServers": {
    "omniwork": { "command": "node", "args": ["/absolute/path/to/omniwork/electron/mcp-server.js"] }
  }
}
```
Then: *"delegate writing the tests to omniwork."* Works with Codex / Cursor / any MCP client — it
speaks standard MCP over stdio, and reuses the desktop app's gateway if it's already running.

## Quick start (from source)

Requires Node.js 22+ (24 recommended).

```bash
git clone https://github.com/VedSoni-dev/omniwork.git
cd omniwork
npm install --legacy-peer-deps   # OmniRoute has a benign marked peer conflict
node scripts/gen-icon.js         # generate the app icon
npm start                        # launch the app
```

Package installers (build on the matching OS):

```bash
npm run dist:win     # or dist:mac / dist:linux  →  output in dist/
```

## How it works

```
┌─ OmniWork (Electron) ─────────────────────────────────────┐
│  Terminal UI  ·  Cowork rail  ·  Agent Deck               │
│      │ IPC                                                │
│  Main process                                             │
│    ├─ SessionManager → N parallel agents                  │
│    │      └─ each agent: tools + MCP + subagents          │
│    └─ spawns OmniRoute sidecar (bundled Node)             │
│           localhost:20128  ◄── free models, no key        │
└───────────────────────────┬───────────────────────────────┘
                            │
              OmniRoute ──► 278+ providers (free tier default)

  mcp-server.js  ──►  Claude Code / Codex delegate here
```

- On boot, `electron/sidecar.js` runs OmniRoute's prebuilt server on a **bundled Node** runtime
  (Electron's own Node can't boot it), and health-checks `localhost:20128/v1`.
- `electron/agent.js` runs an OpenAI-compatible tool-use loop; `spawn_subagents` fans out; MCP
  tools merge in namespaced as `mcp__<server>__<tool>`.
- `electron/sessions.js` runs many agents in parallel; `electron/mcp.js` is the MCP client;
  `electron/mcp-server.js` exposes OmniWork *as* an MCP server (the delegate tool).
- Agent tools are confined to the workspace folder you pick.

## Configuration

Works with zero config. To go beyond the free tier, click **router dashboard** in the app to add
provider keys (stored encrypted, locally), or pick a specific model in the status bar.

| Env | Default | Purpose |
|-----|---------|---------|
| `OMNIWORK_GATEWAY_PORT` | `20128` | Gateway port |
| `OMNIWORK_WORKSPACE` | — | Open a folder on launch |
| `OMNIWORK_MODEL` | `auto` | Pin a model (delegate server) |
| `OMNIWORK_DEV` | — | Devtools + verbose logs |

## Project layout

```
electron/
  main.js        app lifecycle, windows, IPC
  sidecar.js     bundled OmniRoute process manager  ← the core idea
  sessions.js    Cowork: parallel agent sessions
  agent.js       tool-use loop + subagent fan-out (Agent Deck)
  tools.js       file/shell/web tools (workspace-confined)
  mcp.js         MCP client (connect external tool servers)
  mcp-server.js  MCP server (delegate tool for Claude Code / Codex)
  preload.js     contextIsolation-safe IPC bridge
renderer/        the terminal UI (index.html, styles.css, app.js)
```

## Contributing

PRs welcome — this is meant to be a clean, hackable base. Good first issues: streaming token
output, approval/permission mode, git checkpoints + undo, session persistence, an MCP one-click gallery.

## Credits

UX inspired by [Claude Code](https://claude.com/claude-code) and the open-source
[OpenWork](https://github.com/different-ai/openwork). Routing powered by
[OmniRoute](https://github.com/diegosouzapw/OmniRoute).

## License

MIT © OmniWork contributors. OmniRoute is MIT © its authors.
