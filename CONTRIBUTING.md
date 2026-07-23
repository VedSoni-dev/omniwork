# Contributing to OmniWork

Thanks for helping build a truly zero-setup, open-source AI coding agent.

## Dev setup

```bash
git clone https://github.com/VedSoni-dev/omniwork.git
cd omniwork
npm install --legacy-peer-deps   # OmniRoute has a benign marked peer conflict
node scripts/gen-icon.js         # generate the app icon
npm start                        # launch the app (system node runs the gateway in dev)
```

Dev mode uses your system `node` to run the bundled OmniRoute gateway. Packaged
builds ship their own Node binary (see below), so **Node 22+ is required** for dev.

## How it fits together

| File | Role |
|------|------|
| `electron/main.js` | App lifecycle, windows, IPC |
| `electron/sidecar.js` | Boots the bundled OmniRoute gateway as a child process |
| `electron/agent.js` | OpenAI-compatible tool-use loop against `localhost:20128/v1` |
| `electron/tools.js` | File + shell tools, confined to the chosen workspace |
| `renderer/` | The UI |
| `scripts/stage-node.js` | electron-builder `beforePack` hook — bundles a Node binary |
| `scripts/gen-icon.js` | Dependency-free app-icon generator |

## Why a bundled Node binary?

OmniRoute's gateway is a Next.js standalone server that does not boot correctly on
Electron's embedded Node. So we ship a real Node binary alongside the app and spawn
the gateway with it. CI builds each OS on its own runner, so each installer gets a
matching Node binary and native modules stay ABI-compatible.

## Tests

```bash
npm run test:boot    # gateway boots + serves model list (used in CI)
npm run test:smoke   # full end-to-end: gateway -> agent -> file written (needs network)
```

## Building installers

```bash
npm run dist:win     # or dist:mac / dist:linux — build on the matching OS
```

Releases are cut by pushing a `vX.Y.Z` tag; `.github/workflows/release.yml` builds
all three platforms and attaches installers to the GitHub Release.

## Guidelines

- Keep it hackable and dependency-light.
- Match the existing code style (plain CommonJS, no build step for the renderer).
- Open an issue before large changes so we can align on direction.
