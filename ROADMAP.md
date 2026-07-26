# Roadmap

Where OmniWork is going. For what has already shipped, see [CHANGELOG.md](CHANGELOG.md).

Nothing here is a commitment or a schedule — it is the maintainers' current thinking, and it
moves. If you want something on this list, [open an issue](https://github.com/VedSoni-dev/omniwork/issues/new/choose);
if you want to build one, say so there first so we do not duplicate work.

## Current state

Feature-complete for the core idea: a keyless, zero-setup coding agent with a bundled AI
gateway, parallel sessions, subagent fan-out, and MCP in both directions. Shipped for
Windows and macOS (Apple Silicon).

The gap now is **distribution**, not capability.

## Next

**Code-signing and notarization.** The single biggest friction point. Today macOS users have
to right-click → Open past a *"damaged and can't be opened"* warning, and Windows users get a
SmartScreen prompt. Both need paid certificates — an Apple Developer account ($99/yr) and an
OV/EV code-signing certificate.

**Unblock CI.** GitHub Actions is currently billing-locked on this account, so no workflow
runs — the CI badge was pulled from the README rather than show a red state that reflects
billing instead of code. `ci.yml` and `release.yml` are written and validated but have not
executed; treat them as untested until a run goes green.

**Release artifacts for every platform.** Intel macOS and Linux still require building from
source. `.github/workflows/release.yml` already has the matrix; it needs CI minutes to run.

**Git checkpoints.** Commit (or stash) before each agent turn so any change is revertable, not
just the file writes from the most recent turn. Today's `undo` covers only the last turn's
writes and cannot undo a `run_command` side effect.

## Later

- **Cross-arch native modules** so a cross-built package does not fall back to the WASM SQLite
  store
- **Token and cost display** in the status bar, per session
- **Sandboxed `run_command`** — today it runs with full user privileges (see
  [SECURITY.md](SECURITY.md)); an opt-in container or seatbelt profile would let people point
  the agent at untrusted repositories
- **Richer diffs** in approval prompts — real unified diffs rather than whole-block add/remove
- **Session export** to a shareable transcript

## Not planned

- **Accounts, telemetry, or a hosted backend.** OmniWork runs entirely on your machine and that
  is the point.
- **Bundling a specific paid provider.** The gateway already fronts 278+ providers; add your own
  keys in the router dashboard.
- **A renderer build step.** The UI is plain HTML/CSS/JS on purpose — it keeps the project
  hackable and the diff readable.

## Distribution

Package-manager listings (`winget`, Homebrew cask) are blocked on signing — both prefer signed
artifacts, and a cask for an unsigned app is a poor first impression. Signing comes first.
