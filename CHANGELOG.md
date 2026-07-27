# Changelog

All notable changes to OmniWork are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.11.0] — 2026-07-27

Context features from Claude's project view, brought to a coding agent: attachments,
project knowledge, per-project instructions, and scheduled prompts.

### Added

- **Chat attachments.** A 📎 button plus window-wide drag & drop. Images go to vision; text
  files travel as fenced context blocks while the transcript shows a clean `prompt 📎 name`
  label. Oversized files are pointed at project knowledge instead.
- **Project knowledge.** Reference files under `projects/<id>/knowledge/`, listed by name and
  size in the system prompt and read on demand through a `read_knowledge` tool — path-escape
  safe, binary-refusing, truncation-marked.
- **Project home page.** Clicking a project's name opens instructions, memory, context files,
  recents, and scheduled tasks in one view. Per-project `INSTRUCTIONS.md` is injected ahead of
  workspace files into every session in that project.
- **Scheduled prompts.** Recurring hourly/daily/weekly prompts fired into fresh sessions by
  `electron/scheduler.js`. `lastRun` persists, so a restart never replays missed runs.
- **Memory editor.** `/memory` opens an in-app editor over the real `MEMORY.md`, with
  project/global tabs and reveal-in-Finder.
- **Homebrew cask** on a self-hosted tap — `brew install --cask --no-quarantine
  VedSoni-dev/tap/omniwork` — so installing does not require the Gatekeeper dance.
- **Gateway watchdog.** The engine is probed every 20 s; if it disappears (an adopted gateway's
  owner exited, or our own child crashed) a fresh one is started on the same port, so agents
  recover without the base URL changing.

### Fixed

- **Esc now aborts for real**, and pending approvals survive switching between sessions.
- **The watchdog could orphan a gateway on quit.** `stop()` had no guard against an in-flight
  `start()`, so quitting while the watchdog was mid-restart let `start()` spawn a server
  *after* teardown — stranding it on port 20128 and blocking the next launch, the regression
  0.9.1 had fixed. `stop()` now latches an abort flag that `start()` checks before spawning
  and after health, and the watchdog will not resurrect the engine once shutdown has begun.
  Reproduced against the merged code and re-verified after the fix.

## [0.10.0] — 2026-07-27

A large feature release: sessions gain structure (projects, memory, compaction), the agent
gains capability (skills, browsing, approval modes), and delegation from Claude Code now runs
with OmniWork's full environment rather than as a bare agent.

### Added

- **Projects.** Sessions live under projects born from folders — one file per session, with
  automatic migration from the old `sessions.json`.
- **Memory.** Durable `MEMORY.md` per project plus a global scope, injected each turn and
  writable by the agent via `save_memory`.
- **Skills.** Claude Code–compatible `SKILL.md` packs, global or per-project, loaded on demand
  via `use_skill` so a dozen installed skills cost only a few hundred prompt tokens. Agents can
  write their own with `save_skill` and install more with `install_skills`. First boot installs
  Anthropic's public skill set in the background, marker-gated so later boots never clobber
  local edits.
- **Web browsing, no API key.** `web_search` (DuckDuckGo) and `browse_page` render through a
  hidden Electron window, so pages with JavaScript work. Plain-Node contexts such as the MCP
  server fall back to a labeled static fetch.
- **Approval modes**, cycled with Shift+Tab: `auto`, `ask`, `edits` (writes auto-accept,
  commands still prompt), and `plan` (read-only — writes are blocked at the tool layer).
- **Per-turn time and token usage**, e.g. `✔ 4m 55s · ↓ 16.6k tokens`. Counts come from real API
  usage; `chars/4` estimates appear only when the gateway reports nothing and are marked `~`.
- **Conversation compaction** so long sessions keep working, without orphaning tool results.
- **Six MCP tools** for delegating clients — `delegate`, `delegate_parallel`, `web_search`,
  `browse_page`, `list_skills`, `install_skills` — each description stating when *not* to use it.
  Delegated agents now run with OmniWork's installed skills, saved memory and browsing.
- **`npm run connect`** — wires OmniWork into Claude Code: registers the MCP server for the
  current user, adds a tight block to the global `~/.claude/CLAUDE.md`, and installs an
  `omniwork` skill holding the full situation guide, loaded on demand.

  Deliberately *not* a postinstall hook. It edits config affecting every Claude Code session, so
  it prints exactly what it will change and asks first, is idempotent (edits live between
  `BEGIN/END OMNIWORK` markers), backs up what it touches, refuses to run non-interactively
  without `--yes`, and `--uninstall` removes precisely what it added.
- **`npm run setup`** — runs `doctor`, then offers the Claude Code integration. Skip with
  `--no-connect`, accept both with `--yes`.
- Inline rename for sessions and projects (double-click; Enter commits, Esc cancels).
- Test suites for projects/memory, skills, approval modes, compaction, browsing, and the MCP
  stdio protocol.

### Fixed

- **New sessions did not appear until a prompt forced a refresh**, and switching back to an
  earlier session fought a yank-back loop: `create()` left the old `activeId` set, so every
  broadcast told the renderer to navigate back to the stale session. `setActive` now broadcasts
  once, change-guarded, and `switchTo` is sequence-guarded so overlapping calls cannot interleave
  DOM renders.
- The gateway could listen without ever becoming healthy if its storage was corrupted by a hard
  kill; a failed first boot now quarantines the database and retries once.

### Security

- `install_skills` is agent-callable, so its `source` can be steered by prompt injection in
  anything the model read. It now requires an `https://`/`ssh://`/`git@` URL, `owner/repo`, or an
  existing local path, and passes `--` to `git clone`. This closes two argument-shaped vectors —
  a leading `-` parsed as a flag such as `--upload-pack=<cmd>`, and git's `ext::` transport, which
  runs an arbitrary command. Neither fired on a current git with default configuration (verified),
  so this is defense in depth rather than a fix for a live hole.

## [0.9.1] — 2026-07-26

First macOS build. Everything already ran on Windows and Linux, but the app was
effectively unusable when launched as a Mac app — and the Mac artifact it produced would
not start on any machine other than the one that built it.

### Added

- **`npm run doctor`** — verifies Node version, the OmniRoute engine and the app icon, and
  repairs a half-extracted Electron binary by re-extracting the cached download with
  `ditto`. This is the *"Electron failed to install correctly"* state, which a plain
  postinstall re-run cannot fix because it exits early on the partial directory.
- **`electron/shell-path.js`** — resolves the login shell's `PATH` once at startup so
  GUI-launched apps can find developer tooling.
- macOS `.dmg` release artifact (Apple Silicon).

### Fixed

- **Gateway died on window close (macOS).** `window-all-closed` tore down the gateway and
  every MCP server, but on macOS the app stays alive in the dock — so reopening landed on a
  dead engine. Teardown is now skipped on darwin, and `activate` re-shows the existing
  window instead of only handling the zero-window case.
- **Gateway orphaned on termination.** `before-quit` does not fire for SIGTERM/SIGINT/SIGHUP,
  so Ctrl-C, `kill`, or logout left OmniRoute holding port 20128 and blocking the next
  launch. Signal handlers now route through one idempotent shutdown, and the sidecar is
  spawned detached and stopped by process group (SIGTERM, then SIGKILL after 3 s).
- **Duplicate gateways.** A launch that finds a healthy gateway already on the port now
  adopts it rather than racing a second copy onto the same database; adopted gateways are
  left running on stop.
- **MCP servers failed on Finder/Dock launch.** GUI launches inherit a bare `PATH`, so every
  `npx`-based server failed with `ENOENT` — it only worked when launched from a terminal.
- **Packaged app would not launch on other Macs.** The build copied the build machine's own
  Node binary, which on macOS is usually Homebrew's — dynamically linked against
  `libnode.dylib` and friends under `/opt/homebrew`, none of which ship in the bundle. The
  build now downloads the official self-contained Node from nodejs.org selected by *target*
  arch, and fails if the staged binary links anything outside `/usr/lib` or `/System`.
- **Gateway could not resolve its modules.** `asarUnpack` covered three packages, but the
  gateway runs on real Node, which cannot read `app.asar` at all — every module the engine
  resolves has to exist as a real file. All of `node_modules` is unpacked now.
- Traffic lights overlapped the sidebar title under the `hiddenInset` titlebar.
- CSP declared no `img-src`, so `default-src 'self'` silently blocked the `data:` URIs used
  for pasted-image thumbnails.
- Sessions were saved on a 400 ms debounce that never fired before quit; the quit path now
  saves synchronously.
- The model picker fetched once before the gateway was ready and never retried, leaving it
  stuck on five hardcoded entries.
- `run_command` hardcoded `/bin/bash`; it now uses the user's login shell (zsh on macOS).
- `open_url` required `electron`, which resolves to a path string under plain Node — it
  crashed when called from the MCP delegate server.
- The welcome block was removed by an `id` it never had, so it lingered after the first
  message.

### Changed

- `stage-node` fetches the gateway runtime by target architecture, making cross-arch
  packaging correct rather than merely warned about. Downloads are cached under
  `build/.node-cache`; override the version with `OMNIWORK_NODE_VERSION`.

### Removed

- The `test:polish` script, which referenced a `test/polish.js` that does not exist.

## [0.9.0] — 2026-07-24

### Added

- Lite installer that downloads the engine on first run (~136 MB vs ~318 MB), with the
  platform-correct SQLite binary copied in automatically.

## [0.8.0] — 2026-07-24

### Added

- Recipes — one-click agent tasks, several of which fan out to parallel subagents.
- Image paste in the composer (vision input).

## [0.7.0] — 2026-07-24

### Added

- Project memory: `AGENTS.md`, `CLAUDE.md`, `.omniwork.md` and `.cursorrules` are read into
  the system prompt.
- Dynamic model list sourced from the gateway.
- Diff previews in approval prompts.

## [0.6.0] — 2026-07-24

### Added

- Session persistence across restarts.
- One-click MCP gallery.

## [0.5.0] — 2026-07-24

### Added

- Streaming token output.
- Approval mode with per-tool prompts.
- Undo for file changes made during a turn.

## [0.4.0] — 2026-07-24

### Added

- `mcp-server.js` — OmniWork as an MCP server, exposing `delegate` and `delegate_parallel`
  so Claude Code and Codex can offload work to free models.

## [0.3.0] — 2026-07-24

### Added

- Agent Deck — `spawn_subagents` fans work out to parallel subagents, shown live as cards.

## [0.2.0] — 2026-07-24

### Added

- Cowork — many agent sessions running in parallel, each with its own folder and task.
- MCP client for connecting external stdio tool servers.

## [0.1.0] — 2026-07-23

Initial release: Claude Code–style terminal UI, coding agent with file/shell/web tools, and
the OmniRoute gateway bundled as an in-app sidecar.

[Unreleased]: https://github.com/VedSoni-dev/omniwork/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/VedSoni-dev/omniwork/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/VedSoni-dev/omniwork/compare/v0.1.2...v0.2.0
[0.1.0]: https://github.com/VedSoni-dev/omniwork/releases/tag/v0.1.1
