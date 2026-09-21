<div align="center">

<img src="assets/icon.png" width="76" alt="OmniWork" />

# OmniWork

**A local coding harness for Codex, Claude Code, and the desktop—with durable parallel workers and verified patches.**

Submit a batch once. OmniWork schedules workers, isolates their edits, runs acceptance checks,
and returns patches. Use available free models, local inference, or explicitly selected account models.

[![Release](https://img.shields.io/github/v/release/VedSoni-dev/omniwork?color=8bb072&label=release)](https://github.com/VedSoni-dev/omniwork/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-d97757.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/windows%20·%20macOS%20·%20linux-2c2a27)
![Free](https://img.shields.io/badge/free-no%20API%20key-8bb072)

<br/>

<img src="assets/demo.svg" width="820" alt="OmniWork — parallel agents, Agent Deck, MCP connections" />

</div>

---

## Why OmniWork

OmniWork combines **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)**, the official
OpenCode engine, and its own coding loop. A shared worker service keeps engines warm across
MCP clients, queues work within provider capacity, and preserves jobs when a client disconnects.

Then it goes further than a single chat agent: run **many agents in parallel**, let one agent
**fan work out to subagents**, plug in **MCP tools**, and even use OmniWork as a **token-saving
delegate** *inside* Claude Code or Codex.

## Features

| | |
|---|---|
| 🆓 **Model access** | Search connected gateway and OpenCode models. Durable jobs select catalogued free models by default; account models require explicit selection and `allow_paid`. Provider quotas still apply. |
| ⚡ **Durable workers** | Submit up to 100 jobs at once, share a warm service across MCP clients, reconnect to results, and page artifacts on demand. |
| ✅ **Verified patches** | Git snapshots preserve current edits, owned paths constrain accepted changes, and acceptance checks run before and during integration. |
| 🖥️ **Claude Code UI** | A clean terminal: `⏺`/`⎿` tool calls, `✻` thinking, `>` prompt, `@`-file mentions, per-turn time + token counts. |
| 📁 **Projects & memory** | Sessions live under projects. Durable `MEMORY.md` per project plus a global scope — it remembers what you teach it. |
| 🎓 **Skills** | Claude Code–compatible `SKILL.md` packs, loaded on demand. Ships with Anthropic's public set; the agent can write and install more. |
| 🛡️ **Approval modes** | Shift+Tab through `auto` · `ask` · `edits` · `plan`. Plan mode is read-only, blocked at the tool layer. |
| 🤝 **Cowork** | Spawn many agent sessions and run them **in parallel**, each with its own folder + task. |
| 🃏 **Agent Deck** | One agent **fans work out to parallel subagents** — watch them live as a deck of cards. |
| 🌐 **Browsing built in** | `web_search` + `browse_page` render in a real Chromium window — JavaScript pages work, no API key. |
| 🔌 **MCP connections** | Plug in tools (filesystem, GitHub, Postgres, Slack…) via any stdio MCP server. Add from the UI. |
| 🪙 **Delegate tool** | OmniWork is *also* an MCP server — let Claude Code / Codex offload grunt work to its free models. |
| 🔗 **ACP agent** | Speaks Agent Client Protocol, so OpenClaw / acpx / Zed can drive OmniWork as a full coding agent. |
| ✂️ **Select to quote** | Highlighting output copies it instantly; a pill (or `⌘L`) quotes it into the prompt as `> ` lines. |
| 📋 **Collapsed pastes** | Paste 300 lines and the prompt shows `[Pasted text #1 +322 lines]` — the model still gets all of it. |
| 🔒 **Local orchestration** | Jobs, workspaces, and routing run locally. Cloud model providers receive prompts; local inference is available through connected local providers. |
| 🧩 **MIT, hackable** | Plain CommonJS, no build step for the UI. Fork it, ship it, sell it. |

## Download

**macOS (Apple Silicon) — Homebrew:**

```sh
brew install --cask --no-quarantine VedSoni-dev/tap/omniwork
```

(`--no-quarantine` skips the Gatekeeper prompt for the unsigned app; omit it if you'd
rather right-click → Open once.)

Or grab an installer from the [**latest release**](https://github.com/VedSoni-dev/omniwork/releases/latest):

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

Keep Codex or Claude Code as the orchestrator and submit independent coding tasks to the shared
worker service. These changes are available from this checkout; released installers may lag behind.

- `jobs_submit` returns durable IDs for up to 100 tasks. Supply `allowed_paths`, `context_files`, and acceptance `checks`.
- `jobs_wait` waits for results; `jobs_get` returns compact evidence; `jobs_read` pages patches and full results.
- `jobs_apply` reruns checks against the current source before applying an isolated patch.
- `jobs_list`, `jobs_cancel`, and `jobs_status` recover jobs and manage the shared queue.
- `list_models` searches connected model catalogs. Omit the job model for managed free selection, or explicitly select an account model with `policy: "allow_paid"`.

The older `delegate` and `delegate_parallel` tools remain available. They edit the supplied directory
directly and run outside the durable queue's capacity limits.

Try the CLI from this checkout with a `tasks.json` file:

```json
{
  "cwd": "/absolute/path/to/your/git-project",
  "request_id": "slug-fix-001",
  "tasks": [{
    "task": "Fix slug generation for empty input and repeated separators.",
    "allowed_paths": ["src/slug.js"],
    "context_files": ["src/slug.js", "test/slug.test.js"],
    "checks": ["node --test test/slug.test.js"]
  }]
}
```

```sh
npm run jobs -- submit tasks.json
npm run jobs -- wait <job-id>
npm run jobs -- get <job-id>
npm run jobs -- apply <job-id>
```

Replace the paths and check command with those in your project. The default Git worktree snapshot
includes current nonignored changes; ignored dependencies need an explicit `setup` command.
See the [worker service guide](docs/worker-service.md) for configuration, contracts, and limits.

### Set it up in one command

```bash
npm run connect
```

This registers the MCP server for your user and adds a short section to your global
`~/.claude/CLAUDE.md` explaining when delegating is worth it. It shows you exactly what it will
change and asks first — both files are global and affect every Claude Code session, so nothing
happens silently. Re-running it updates in place rather than duplicating, and it leaves a
`.omniwork-backup` beside anything it edits.

Undo it completely at any time:

```bash
npm run connect -- --uninstall
```

Then restart Claude Code and ask: *"delegate writing the tests to omniwork."*

<details>
<summary>Manual setup, or another MCP client</summary>

OmniWork speaks standard MCP over stdio, so it works with Codex, Cursor, or anything else that
supports it. Add to `.mcp.json` (or run `claude mcp add`):

```json
{
  "mcpServers": {
    "omniwork": { "command": "node", "args": ["/absolute/path/to/omniwork/electron/mcp-server.js"] }
  }
}
```

</details>

For Codex, register the same stdio server:

```sh
codex mcp add omniwork -- node /absolute/path/to/omniwork/electron/mcp-server.js
```

Durable jobs start a background service automatically; the desktop app need not stay open.
Later clients reuse that service and its engines. The first model request can still incur provider
or engine startup latency.

### Get useful work per token

Split work along independent file ownership boundaries. Give each worker a self-contained contract,
a few relevant files, and checks that distinguish a correct solution from a plausible one. Wait for
compact evidence, inspect the patch, then apply it. One repair attempt is enabled by default and
shares the original deadline and observed token budget. Stronger models can be selected explicitly
for tasks that need them.

For bounded local coding tasks, select `engine_profile: "scoped"` to omit the automatic skills catalog and unrelated tools while retaining model-specific coding instructions and project rules. The full `standard` profile remains the default; the compact-prompt `focused` profile is experimental. See [coding benchmarks](docs/coding-benchmarks.md) for measured savings and quality limits.

This reduces repeated setup and transcript copying. It does not create unlimited provider quota
or guarantee that a free model solves every task. Check quality still determines what “verified” means.

## Fewer tokens per task 🗜️

OmniWork limits repeated context without silently rewriting source or evidence. Tool results larger than 12k characters are paged, and `read_output` retrieves the original text by character offset. `read_file` supports targeted line ranges (200 lines by default, up to 400). Long single-task runs compact at complete tool-cycle boundaries, preserving the task constraints.

Single and parallel MCP delegations return a structured result with `status` (`completed`, `partial`, `failed`, or `cancelled`), `reason`, successful `changes`, actual model attempts, token usage when available, and verification results. An assistant summary alone is **unverified**. Supply `checks: ["npm test"]` to run explicit acceptance commands; failed checks produce an error result. These commands execute in the requested workspace. Parallel requests accept up to 100 tasks, queue four at a time, and return every result. MCP cancellation and deadlines stop active agents and shell commands. In-loop workers inherit the parent's permissions, memory, and skills.

| Environment variable | Default | Effect |
|---|---|---|
| `OMNIWORK_COMPRESSION` | off | `rtk` explicitly opts into upstream lossy compression; default sends `off` on every request, including reused gateways |
| `OMNIWORK_MODEL_TIERS` | on | `off` disables fast-to-coding escalation for `auto` |
| `OMNIWORK_UTILITY_MODEL` | fast for auto; selected model for pinned choices | Explicit override for titles, memory, and compaction |
| `OMNIWORK_DELEGATE_TIMEOUT_MS` | 600000 | Deadline for each MCP task including acceptance checks |
| `OMNIWORK_DATA_DIR` | platform app directory | Alternate headless data directory for isolated environments |

Rate-limit cooldowns persist across steps and are shared by workers using the same gateway. `Retry-After` is honored. Session IDs support affinity, but cache savings require provider usage evidence; they are not assumed. Raw output is retained in a bounded session-local store (8 million characters); expired references require rerunning the tool. Commands producing over 2 million characters are stopped with a visible notice.

### More models through your existing accounts

Open **Models & providers** in the sidebar to search models, filter free choices or advertised tool support, see context sizes, and select a model. **Test** sends a small readiness prompt at that model's rates. It does not execute tools or establish coding quality. Some providers reject restricted probes even when normal engine tasks work; failures show that distinction. Catalog listings begin untested, and availability can change.

OmniWork now exposes **all providers connected to its OpenCode engine**, including custom providers, instead of only a fixed list of free Zen models. Existing free IDs such as `opencode/nemotron-3.5-lightning-free` remain valid. Connected account models use `opencode/<provider>/<model>`, preventing provider collisions. Paid or unknown-cost models require explicit selection and are never used as automatic engine fallback.

```bash
npm run providers -- login
```

This opens the official OpenCode CLI authentication flow in your terminal. Complete login, then refresh the model browser. Keys remain in OpenCode's own credential store. If a running engine has cached old provider configuration, restart OmniWork after connecting. [OpenCode provider setup](https://opencode.ai/docs/providers/) covers account and custom-endpoint configuration. No new client-identity synthesis is added by this feature; OmniRoute remains the existing gateway dependency.

Run `npm run test:regression` before shipping. CI and release builds now require the deterministic suites, including failure reporting, nine-task batches, compaction, cancellation, free fallback selection, and output retrieval.

## Connect free model providers 🆓

The gateway's built-in keyless pool is a set of unofficial endpoints that providers shut off
without notice — on a bad day every one of them is gone and `auto` returns 503. So OmniWork
makes the durable kind of free easy: real free tiers behind a free account, no card.

| Provider | Free tier | Connect |
|---|---|---|
| **OpenRouter** | Free and paid catalogs; account limits apply | one click — browser sign-in, no key to paste |
| **Ollama Cloud** | DeepSeek V4, Kimi K2.6, GLM 5.1, Gemma 4 on a "light usage" tier | paste a key |
| **Kilo Gateway** | `kilo-auto/free` router + Nemotron / MiniMax `:free` | paste a key |
| **Groq** | gpt-oss-120b at 30 req/min, 1,000 req/day; Qwen 3 32B | paste a key |
| **Cerebras**, **NVIDIA NIM**, **Gemini**, **Mistral** | free developer tiers | paste a key |
| **OpenCode engine** | Zen's current free models, plus models from connected accounts; use the live catalog | ships with a clone and with the desktop app; otherwise one click downloads it (~45 MB) |
| **Ollama / LM Studio / llama.cpp / vLLM** | whatever runs on your machine | auto-detected |

Three ways in, all the same code path:

- **App** — *Models & providers* in the sidebar. Connected providers become every session's fallback chain on the spot.
- **Terminal** — `npm run providers` shows status; `npm run providers connect openrouter` opens the browser; `npm run providers connect groq <key>`; `npm run providers connect local`; `npm run providers connect opencode` downloads the engine if a clone or installer didn't bring it. Also `npx omniwork-providers`.
- **From a harness** — the MCP server has `list_providers` / `connect_provider`; the ACP server offers `openrouter` and `local` as auth methods.

A pasted key is exercised once before it is kept, so a bad key never lands in the pool. What is
connected becomes the default fallback chain for the MCP and ACP servers (unless you set
`OMNIWORK_MODEL_FALLBACKS` yourself), ordered strongest coder first, local last.

**The OpenCode engine provides another execution path.** OmniWork runs the official engine and discovers its providers. Nobody has to install anything or touch
their PATH: `npm install` brings OpenCode in as an optional dependency (`opencode-ai`, the binary
for your platform), the desktop installers stage it per platform at build time, and if it is
missing anyway one click fetches the same npm package (~45 MB) into OmniWork's data folder —
verified against the sha512 pinned in `package-lock.json` before a byte of it runs. OmniWork
always launches it by absolute path, and the server it starts answers only requests carrying a
per-process secret. Set `OMNIWORK_ENGINE_FALLBACK=off` if a failed turn should stay failed rather
than finish on the engine. With OpenCode installed, `opencode/<model>`
runs a session on OpenCode's own headless server (`opencode serve`, the same thing Zed and acpx
drive) and its own tools, scoped to your workspace, streamed back as OmniWork events — text as
text, the model's reasoning on its own lane, tool calls as tool calls. Pick one in the model
menu, pass `model: "opencode/nemotron-3.5-lightning-free"` to `delegate`, or do nothing: when no
gateway model answers before tools have run, MCP delegation can retry on a free engine model and records the attempt. Availability remains provider-dependent. What you give up there is
OmniWork's own skills and memory — OpenCode runs its tools, not ours.

## Drive OmniWork from OpenClaw, Zed, or any ACP harness 🔌

The MCP server makes OmniWork a *tool* your agent calls. The **ACP server** makes it a full
**coding agent** that another harness drives — OpenClaw, [acpx](https://github.com/openclaw/acpx),
Zed, Neovim, anything that speaks the
[Agent Client Protocol](https://agentclientprotocol.com). The harness owns the UI, the approval
prompts, and the transcript; OmniWork does the work on free models.

```json
// ~/.acpx/config.json  or  <repo>/.acpxrc.json
{ "agents": { "omniwork": { "argv": ["npx", "-y", "omniwork-acp"] } } }
```

```json
// openclaw.json
{ "plugins": { "entries": { "acpx": { "enabled": true, "config": {
  "agents": { "omniwork": { "command": "npx", "args": ["-y", "omniwork-acp"] } }
} } } } }
```

Then `acpx omniwork "fix the flaky test"`, or spawn it as an OpenClaw subagent.

What the harness gets:

| | |
|---|---|
| **Streaming output** | Text, reasoning, and per-tool status as they happen |
| **Native diffs** | `write_file` / `edit_file` arrive as ACP diffs, not "wrote 412 bytes" |
| **Permission prompts** | Every gated tool call becomes `session/request_permission` — "allow always" flips the session to auto |
| **The Agent Deck** | `spawn_subagents` shows up as *N* live parallel tool calls, not one opaque block |
| **Skills as slash commands** | Installed skills are published via `available_commands_update` |
| **Modes** | `ask` (default), `edits`, `auto`, `plan` — switch with `acpx omniwork set-mode plan` |
| **Model selection** | The gateway catalog as a `model` config option — `session/set_config_option`, the older `session/set_model`, or `_meta.model` on `session/new` — with a fallback chain if the pick fails |
| **Auth methods** | `authenticate({ methodId: "openrouter" })` opens the browser for a free OpenRouter key; `"local"` registers a running Ollama / LM Studio / llama.cpp / vLLM; `"opencode"` installs OpenCode for its free Zen models |
| **Resumable sessions** | `session/load` replays the transcript, so a crashed harness picks up where it left off |

Modes default to **ask** because ACP's whole point is that the client owns the permission
boundary. Set `OMNIWORK_ACP_MODE=auto` if you'd rather it run unattended.

By default OmniWork runs on its own bundled OmniRoute gateway on `auto` (the free pool). To
pin a model — a specific coder, or a paid one you've keyed in the router dashboard — pick it per
session (ACP: the `model` config option, `session/set_model`, or `_meta.model` on
`session/new`; MCP: the `model` parameter on `delegate`) or set `OMNIWORK_MODEL`.

Free catalogs go stale — a pinned model can 401 as "not supported" the day its provider retires
it — so a fallback chain is always in play. By default it is built from whatever free providers
are [connected](#free-models-that-stay-up), strongest coder first, local server last;
`OMNIWORK_MODEL_FALLBACKS` (or `fallback_models` / `_meta.fallbackModels`) replaces it with your
own list, in order. The same request goes to the next model, the one that answers becomes the
session's model, and the switch is reported (a `config_option_update` on ACP, a `[model: …]`
note on MCP results). If every model fails, the error names each one and why. End the chain with
a paid model when the work must complete:

```bash
OMNIWORK_MODEL=oc/some-free-coder OMNIWORK_MODEL_FALLBACKS=auto,anthropic/claude-sonnet-5 npx omniwork-acp
```

To spend a different provider's budget entirely, point the servers elsewhere — `OMNIWORK_BASE_URL`
and `OMNIWORK_API_KEY` apply to both.

## Build from source

Requires **Node.js 22+** (24 recommended).

```bash
git clone https://github.com/VedSoni-dev/omniwork.git
cd omniwork
npm install --legacy-peer-deps   # OmniRoute has a benign marked peer conflict
npm run setup                    # verify/repair setup, then offer Claude Code integration
npm start                        # launch the app
```

`npm run setup` runs [`doctor`](#build-from-source) and then offers to
[connect OmniWork to Claude Code](#set-it-up-in-one-command). Use `npm run doctor` alone to skip
the integration prompt, or `npm run setup -- --no-connect`.

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
  acp-server.js  ──►  OpenClaw / acpx / Zed drive OmniWork here
```

- On boot, `electron/sidecar.js` runs OmniRoute's prebuilt server on a **bundled Node** runtime
  (Electron's own Node can't boot it) and health-checks `localhost:20128/v1`. If a healthy gateway
  is already on the port, it adopts that one instead of starting a second.
- `electron/agent.js` runs an OpenAI-compatible tool-use loop; `spawn_subagents` fans out; MCP
  tools merge in namespaced as `mcp__<server>__<tool>`.
- `electron/sessions.js` runs many agents in parallel; `electron/mcp.js` is the MCP client;
  `electron/mcp-server.js` exposes OmniWork *as* an MCP server (the delegate tool), and
  `electron/acp-server.js` exposes it as an ACP agent. Both are headless stdio servers sharing
  `electron/headless.js` for gateway, skills, and memory wiring.
- Agent file tools are confined to the workspace folder you pick. See [SECURITY.md](SECURITY.md)
  for what that does and does not cover.

## Configuration

Works with zero config. To get a free tier that stays up, use **🆓 free models** in the app (or
`npm run providers`); to add any other provider key, click **router dashboard** (keys are stored
encrypted, locally). Pick a specific model in the status bar.

| Env | Default | Purpose |
|-----|---------|---------|
| `OMNIWORK_GATEWAY_PORT` | `20128` | Gateway port |
| `OMNIWORK_WORKSPACE` | — | Open a folder on launch |
| `OMNIWORK_MODEL` | `auto` | Pin a model (MCP + ACP servers) |
| `OMNIWORK_MODEL_FALLBACKS` | connected providers | Comma-separated models to try, in order, when the model fails (MCP + ACP servers). Unset: built from connected free providers; set empty to disable |
| `OMNIWORK_ENGINE_FALLBACK` | on | `off` keeps a turn that no gateway model could serve as an error instead of finishing it on the OpenCode engine |
| `OMNIWORK_BASE_URL` | — | Run headless servers against another OpenAI-compatible endpoint |
| `OMNIWORK_API_KEY` | `omniwork` | Key for `OMNIWORK_BASE_URL` |
| `OMNIWORK_ACP_MODE` | `ask` | Starting approval mode for ACP sessions |
| `OMNIWORK_DELEGATE_TIMEOUT_MS` | `600000` | Backstop before a stalled delegate returns partial work |
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
  acp-server.js   ACP agent (OpenClaw / acpx / Zed drive OmniWork)
  headless.js     shared bootstrap for both stdio servers
  preload.js      contextIsolation-safe IPC bridge
renderer/         the terminal UI (index.html, styles.css, app.js)
scripts/
  stage-node.js   fetches the gateway's Node runtime at package time
  setup.js        doctor + optional Claude Code integration
  connect.js      registers the MCP server and installs delegate guidance
  doctor.js       setup verification + repair
  gen-icon.js     dependency-free app-icon generator
test/             boot · smoke · cowork · features · persist · mcp · acp · sidecar
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
