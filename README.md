<div align="center">

<img src="assets/icon.png" width="76" alt="OmniWork" />

# OmniWork

**A free, local, Claude&nbsp;Code–style coding agent — with a whole AI gateway baked in.**

Download it, open a folder, and start building. No API key. No login. No config.
Free models work the second you launch — and you can run a whole *team* of agents at once.

[![Release](https://img.shields.io/github/v/release/VedSoni-dev/omniwork?color=8bb072&label=release)](https://github.com/VedSoni-dev/omniwork/releases/latest)
[![CI](https://github.com/VedSoni-dev/omniwork/actions/workflows/ci.yml/badge.svg)](https://github.com/VedSoni-dev/omniwork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-d97757.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/windows%20·%20macOS%20·%20linux-2c2a27)
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

From the [**latest release**](https://github.com/VedSoni-dev/omniwork/releases/latest):

| Platform | File | Size | Notes |
|---|---|---|---|
| **macOS** (Apple Silicon) | `OmniWork-<ver>-arm64.dmg` | ~684 MB | Engine bundled. [Unsigned — see below](#first-launch-on-macos) |
| **Windows** (full) | `OmniWork.Setup.<ver>.exe` | ~318 MB | Engine bundled — usable instantly |
| **Windows** (lite) | `OmniWork-Lite-Setup-<ver>.exe` | ~136 MB | Downloads the engine on first run (~1–3 min, once) |
| macOS (Intel) · Linux | — | — | [Build from source](#build-from-source) |

Open it, pick a folder, type a task. First launch takes ~30–60 s (one-time database
setup), and is fast afterwards.

### First launch on macOS

The `.dmg` is **not code-signed or notarized**, so macOS blocks it the first time. To run it:

1. Drag **OmniWork** to Applications
2. **Right-click the app → Open**, then confirm

Double-clicking instead shows *"OmniWork is damaged and can't be opened"* — the app is fine,
that's just Gatekeeper's message for unsigned apps. If it still refuses:

```bash
xattr -dr com.apple.quarantine /Applications/OmniWork.app
```

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

## Build from source

Requires **Node.js 22+** (24 recommended).

```bash
git clone https://github.com/VedSoni-dev/omniwork.git
cd omniwork
npm install --legacy-peer-deps   # OmniRoute has a benign marked peer conflict
npm run doctor                   # verify/repair the setup, generate the icon
npm start                        # launch the app
```

**`npm run doctor`** is worth running whenever something looks broken. It checks your Node
version, the OmniRoute engine and the app icon — and it repairs the most common failure, a
half-extracted Electron binary (*"Electron failed to install correctly"*), which happens when the
~100 MB postinstall download is interrupted or when npm defers install scripts. It re-extracts from
the cached download instead of making you reinstall.

### Packaging installers

```bash
npm run dist:mac     # or dist:win / dist:linux  →  output in dist/
```

Build on the matching **OS**. Architecture is handled for you: the gateway's Node runtime is
downloaded from nodejs.org for the *target* arch, so an Apple Silicon Mac can produce a working
x64 build. The one caveat is native modules — `better-sqlite3` is compiled for the build host, so
a cross-arch build falls back to OmniRoute's WASM (`sql.js`) store, which works but is slower. For
release-quality artifacts, build each architecture on its own runner (see
[`.github/workflows/release.yml`](.github/workflows/release.yml)).

Locally built `.app`s are unsigned — same right-click → Open dance as above.

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
  (Electron's own Node can't boot it) and health-checks `localhost:20128/v1`. If a healthy gateway
  is already on the port, it adopts that one instead of starting a second.
- `electron/agent.js` runs an OpenAI-compatible tool-use loop; `spawn_subagents` fans out; MCP
  tools merge in namespaced as `mcp__<server>__<tool>`.
- `electron/sessions.js` runs many agents in parallel; `electron/mcp.js` is the MCP client;
  `electron/mcp-server.js` exposes OmniWork *as* an MCP server (the delegate tool).
- Agent file tools are confined to the workspace folder you pick. See [SECURITY.md](SECURITY.md)
  for what that does and does not cover.

## Configuration

Works with zero config. To go beyond the free tier, click **router dashboard** in the app to add
provider keys (stored encrypted, locally), or pick a specific model in the status bar.

| Env | Default | Purpose |
|-----|---------|---------|
| `OMNIWORK_GATEWAY_PORT` | `20128` | Gateway port |
| `OMNIWORK_WORKSPACE` | — | Open a folder on launch |
| `OMNIWORK_MODEL` | `auto` | Pin a model (delegate server) |
| `OMNIWORK_NODE` | — | Node binary used to run the gateway in dev |
| `OMNIWORK_NODE_VERSION` | build host's | Node version staged into packaged builds |
| `OMNIWORK_DEV` | — | Devtools + verbose logs |

## Project layout

```
electron/
  main.js         app lifecycle, windows, IPC
  sidecar.js      bundled OmniRoute process manager  ← the core idea
  shell-path.js   repairs PATH for GUI (Finder/Dock) launches
  engine-fetch.js downloads the engine on first run (lite builds)
  sessions.js     Cowork: parallel agent sessions
  agent.js        tool-use loop + subagent fan-out (Agent Deck)
  tools.js        file/shell/web tools (workspace-confined)
  mcp.js          MCP client (connect external tool servers)
  mcp-server.js   MCP server (delegate tool for Claude Code / Codex)
  preload.js      contextIsolation-safe IPC bridge
renderer/         the terminal UI (index.html, styles.css, app.js)
scripts/
  stage-node.js   fetches the gateway's Node runtime at package time
  doctor.js       setup verification + repair
  gen-icon.js     dependency-free app-icon generator
test/             boot · smoke · cowork · features · persist
```

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — what shipped, when
- [ROADMAP.md](ROADMAP.md) — what's next, and what is explicitly not planned
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, architecture notes, how to send a PR
- [SECURITY.md](SECURITY.md) — the agent's trust model and how to report a vulnerability

## Contributing

PRs welcome — this is meant to be a clean, hackable base. Open areas:

- **Code-signing + notarization** so macOS and Windows builds install without warnings
- **Intel macOS and Linux release artifacts** (needs CI runners; see `release.yml`)
- **Git checkpoints** — commit before each agent turn so any change is revertable
- **Cross-arch native modules** so `better-sqlite3` doesn't fall back to WASM
- **Token/cost display** in the status bar

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## Credits

UX inspired by [Claude Code](https://claude.com/claude-code) and the open-source
[OpenWork](https://github.com/different-ai/openwork). Routing powered by
[OmniRoute](https://github.com/diegosouzapw/OmniRoute).

## License

MIT © OmniWork contributors. OmniRoute is MIT © its authors.
