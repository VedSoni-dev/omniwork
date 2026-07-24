# OmniWork — build progress

## Status: ✅ SHIPPED — v0.3.0 (Agent Deck — parallel subagents)

- **Repo:** https://github.com/VedSoni-dev/omniwork (public, MIT)
- **Latest:** https://github.com/VedSoni-dev/omniwork/releases/tag/v0.3.0 — `OmniWork.Setup.0.3.0.exe`

### Delivered
- [x] Electron app, OmniRoute bundled as in-app sidecar (zero setup, free models, no keys)
- [x] Claude Code terminal UI (monospace, ⏺/⎿ tools, ✻ thinking, > prompt)
- [x] Real coding agent: read/write/edit/run, workspace-confined
- [x] **Cowork**: parallel agent sessions, session rail w/ live status, per-session workspace
- [x] **MCP connections**: dep-free stdio JSON-RPC client, mcpServers config, add/remove in UI,
      tools namespaced mcp__server__tool and merged into the agent
- [x] **Codex-style tools**: web_fetch (pages/APIs), open_url (browser)
- [x] Tests: test/cowork.js (2 parallel sessions) PASS; MCP client verified vs memory server
- [x] Windows installer built + released each version; repo pushed

### Needs the user
- **GitHub Actions billing lock** → macOS/Linux auto-build blocked. Build from source until fixed.
- Installer ~317 MB (bundles full OmniRoute) — inherent, one-time.

### Next ideas
- Streaming tokens, session history persistence, richer diffs, MCP OAuth servers, size trim.
