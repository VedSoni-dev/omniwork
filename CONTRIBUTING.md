# Contributing to OmniWork

Thanks for helping build a truly zero-setup, open-source AI coding agent.

## Dev setup

Requires **Node.js 22+** (24 recommended).

```bash
git clone https://github.com/VedSoni-dev/omniwork.git
cd omniwork
npm install --legacy-peer-deps   # OmniRoute has a benign marked peer conflict
npm run doctor                   # verify/repair setup, generate the icon
npm start                        # launch the app
npm run dev                      # ...or with devtools + verbose gateway logs
```

In dev, the gateway runs on your system `node` (override with `OMNIWORK_NODE`). Packaged
builds ship their own Node binary — see [below](#things-that-are-load-bearing).

If anything looks broken, run **`npm run doctor`** first. It checks your Node version, the
engine and the icon, and repairs a half-extracted Electron binary — the
*"Electron failed to install correctly"* state that a plain postinstall re-run cannot fix,
because it exits early on the partial directory.

## How it fits together

| File | Role |
|------|------|
| `electron/main.js` | App lifecycle, windows, IPC |
| `electron/sidecar.js` | Boots the bundled OmniRoute gateway as a child process |
| `electron/shell-path.js` | Repairs `PATH` for GUI (Finder/Dock) launches |
| `electron/engine-fetch.js` | Downloads the engine on first run (lite builds) |
| `electron/agent.js` | OpenAI-compatible tool-use loop against `localhost:20128/v1` |
| `electron/sessions.js` | Cowork — many agents in parallel, plus persistence |
| `electron/tools.js` | File + shell + web tools |
| `electron/mcp.js` | MCP client (connect external stdio tool servers) |
| `electron/mcp-server.js` | MCP server — the `delegate` tool for Claude Code / Codex |
| `renderer/` | The UI (no build step — plain HTML/CSS/JS) |
| `scripts/stage-node.js` | electron-builder `beforePack` hook — stages the gateway's Node |
| `scripts/setup.js` | `doctor` + optional Claude Code integration |
| `scripts/connect.js` | Registers the MCP server, installs delegate guidance |
| `scripts/doctor.js` | Setup verification + repair |
| `scripts/gen-icon.js` | Dependency-free app-icon generator |

## Things that are load-bearing

These are non-obvious and easy to break. Each one cost a debugging session.

**Why a bundled Node binary.** OmniRoute's gateway is a Next.js standalone server that does not
boot correctly on Electron's embedded Node (worker/instrumentation incompatibilities), so we ship
a real Node binary and spawn the gateway with it.

**That binary must be self-contained.** `stage-node.js` downloads the official build from
nodejs.org rather than copying the build machine's `process.execPath`. Copying looks simpler but
ships a dead app: package-manager Node binaries are dynamically linked against libraries that only
exist on the build machine — Homebrew's node needs `@rpath/libnode.<abi>.dylib` plus
llhttp/libuv/ada/simdjson/brotli from `/opt/homebrew`, none of which are in the bundle. The build
runs `otool -L` on the result and fails rather than shipping a runtime linked outside `/usr/lib`
and `/System`.

**`asarUnpack` must cover all of `node_modules`.** The gateway runs on that real Node binary, and
plain Node has no idea what an asar archive is. Every module the engine resolves — `next` and its
entire tree included — has to exist as a real file on disk. Narrowing this list brings back
`MODULE_NOT_FOUND` at launch.

**macOS keeps the app alive after the last window closes.** So `window-all-closed` must not tear
down the gateway on darwin, and `before-quit` is not sufficient for cleanup — it does not fire on
SIGTERM/SIGINT/SIGHUP. Both paths route through one idempotent `shutdown()`; without it the
gateway orphans onto port 20128 and blocks the next launch.

**GUI launches have a bare `PATH`.** Apps started from Finder or the Dock do not inherit your
shell environment, so `npx`-based MCP servers fail with `ENOENT` unless `shell-path.js` has run.
Anything that spawns a user-installed binary depends on it.

**`connect.js` is not a postinstall hook, on purpose.** It edits `~/.claude.json` and the global
`CLAUDE.md`, which shape every Claude Code session on the machine — doing that silently because
someone ran `npm install` would be a good way to get the project distrusted. Keep it opt-in, keep
it printing what it will change before it changes anything, keep every edit idempotent and inside
the `BEGIN/END OMNIWORK` markers, and keep `--uninstall` removing exactly what was added and
nothing else.

## Tests

```bash
npm run test:boot      # gateway boots + serves the model list (used in CI)
npm run test:smoke     # end-to-end: gateway -> agent -> file written on disk
npm run test:cowork    # parallel sessions
npm run test:features  # streaming, undo, approval
npm run test:persist   # save/restore across restarts
```

`test:boot` is the CI gate. The rest need network access and live free-provider
availability, so they are run locally before a release.

## Building installers

```bash
npm run dist:mac     # or dist:win / dist:linux  →  output in dist/
```

Build on the matching **OS**. Architecture is handled for you — the gateway's Node runtime is
fetched for the *target* arch, so an Apple Silicon Mac can produce a working x64 build. The
remaining caveat is native modules: `better-sqlite3` is compiled for the build host, so a
cross-arch build falls back to OmniRoute's WASM (`sql.js`) store. It works, but it is slower, so
release artifacts should be built per-architecture in CI.

Releases are cut by pushing a `vX.Y.Z` tag; `.github/workflows/release.yml` builds each platform
and attaches the installers to the GitHub Release.

## Sending a PR

1. Open an issue before large changes so we can align on direction.
2. Keep it hackable and dependency-light — new runtime dependencies need a reason.
3. Match the existing style: plain CommonJS, no build step for the renderer, comments that
   explain *why* rather than restating the code.
4. Run `npm run test:boot` plus whatever suite covers your change.
5. Note anything you could not verify. "Tested on macOS only" is useful; silence is not.

Add an entry to [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]` for anything
user-visible.
