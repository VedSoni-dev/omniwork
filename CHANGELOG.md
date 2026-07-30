# Changelog

All notable changes to OmniWork are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **ACP server** — OmniWork now speaks the [Agent Client Protocol](https://agentclientprotocol.com)
  (v1) over stdio, so any ACP harness can drive it as a full coding agent: OpenClaw, acpx, Zed,
  Neovim. Where the MCP server makes OmniWork a *tool* your agent calls, this makes it an *agent*
  another harness runs.

  Register it with `{ "agents": { "omniwork": { "argv": ["npx","-y","omniwork-acp"] } } }` in
  `~/.acpx/config.json`, or under `plugins.entries.acpx.config.agents` in `openclaw.json`.

  The agent loop's existing events map onto the protocol directly: text and reasoning stream as
  message chunks, every tool call reports `pending → in_progress → completed` with its ACP kind,
  and `write_file`/`edit_file` arrive as native diffs rather than a byte count. Gated tool calls
  become `session/request_permission`, where "allow always" flips the session to auto mode instead
  of silently prompting again. The Agent Deck surfaces as *N* live parallel tool calls, installed
  skills are published as slash commands, and `session/load` replays a transcript so a crashed
  harness resumes where it left off. Approval modes (`ask`, `edits`, `auto`, `plan`) are exposed as
  ACP session modes; `ask` is the default, because in ACP the client owns the permission boundary.
- **Add to chat** — highlight any text in the transcript and a small pill offers to quote it
  into the composer, or press `⌘L` / `Ctrl+L`. The quote lands in the prompt as visible `> `
  lines you can read and edit before sending, dimmed by a highlight layer behind the
  textarea.
- **Collapsed pastes** — paste (or quote) more than a few lines and the prompt shows
  `[Pasted text #1 +322 lines]` instead of a wall of text, the way Claude Code does. The body
  is held aside and spliced back in on the way to the model.

  The token is a single unit: one Backspace or Delete touching it removes the whole block
  rather than nibbling it into unmatchable debris, so the keypress right after pasting undoes
  the paste. Editing a token apart also drops its body — what gets sent is always what you
  can see.

  Once submitted the block opens under the prompt line, capped and scrollable like a tool
  card, with a click to collapse it again. The bodies ride on the transcript event, so they
  are still there after a restart.
- **Copy on select** — highlighting text in the transcript copies it to the clipboard
  immediately, the way a terminal does. Scoped to agent output: selections inside the
  composer, project fields, and modals are left alone, since selecting there means editing.
  Toggle with `/copy on|off`; the setting persists in `prefs.json`.
- **`npm run connect`** — wires OmniWork into Claude Code as a delegate target: registers the
  `omniwork` MCP server for the current user and adds a section to the global
  `~/.claude/CLAUDE.md` describing when delegating is worth it.

  Deliberately *not* a postinstall hook. It edits config that affects every Claude Code
  session, so it prints exactly what it will change and asks first, is idempotent (edits
  live between `BEGIN/END OMNIWORK` markers and update in place), backs up anything it
  touches, refuses to run non-interactively without `--yes`, and `--uninstall` removes
  precisely what it added.
- **`npm run setup`** — runs `doctor`, then offers the Claude Code integration. Skip the
  prompt with `--no-connect`, or accept both with `--yes`.

### Changed

- **Delegation is substantially faster.** Three things were making an MCP `delegate` call take
  far longer than the work justified:

  The agent tried a streaming request first and fell back to a non-streaming one whenever the
  stream came back empty — which free `auto` routing does often. Nobody reads the token stream
  during delegation, so that fallback was buying nothing and costing a second full request on
  every affected step, up to 40 steps per task. Headless callers now make exactly one request per
  step, and parallel subagents never stream either, since only their tool labels and final summary
  are ever read.

  The OmniRoute gateway also booted lazily on the *first* delegate call, so the caller paid the
  entire cold start — tens of seconds, or an engine download on lite builds — before any work
  started. It now starts in the background at `initialize`, overlapping with the host reading the
  tool list.

  Finally, delegation reported nothing until it was completely finished, so a slow call and a hung
  one looked identical. Delegate calls now emit `notifications/progress` per step and per finished
  subagent, and a stalled turn is cut off at `OMNIWORK_DELEGATE_TIMEOUT_MS` (default 10 min) and
  returns its partial work instead of hanging until the client gives up.
- Both headless servers (MCP and ACP) share `electron/headless.js` for gateway, skills, memory,
  and project wiring, and both honour `OMNIWORK_BASE_URL` / `OMNIWORK_API_KEY` to run against an
  OpenAI-compatible endpoint other than the bundled gateway.

### Fixed

- **A wedged gateway no longer takes the app down with it.** If a previous run left an OmniRoute
  process bound to port 20128 but no longer answering, every subsequent boot failed — and failed
  slowly, then reported only `Gateway exited (code 1)`.

  Two things were wrong. The health-check loop called `fetch` with no per-request timeout, so a
  process that accepts the connection and never replies parked each poll for undici's 300 s
  default; the loop's own 90 s deadline is only evaluated between iterations, so it never fired.
  And a child that died instantly on `EADDRINUSE` was indistinguishable from one still starting
  up, so the loop kept polling a port owned by somebody else.

  Health checks are now bounded per request, a dead child ends the wait immediately, and
  `EADDRINUSE` is handled as its own case: re-probe patiently first, since the holder is often a
  healthy gateway that was merely slower than the 2 s startup probe, and adopt it if so. If it
  really is wedged, the sidecar starts on an OS-assigned free port instead. It does not kill the
  holder — that process may not belong to OmniWork, and taking a port by force isn't a decision to
  make on the user's behalf.

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

[Unreleased]: https://github.com/VedSoni-dev/omniwork/compare/v0.9.1...HEAD
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
