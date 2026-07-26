# Security

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/VedSoni-dev/omniwork/security/advisories/new)
rather than opening a public issue. Include reproduction steps and the version you tested.

Expect an initial response within a week. This is a volunteer-maintained project, so there is
no formal SLA beyond that.

## Trust model — read this before running an agent

OmniWork is an autonomous coding agent. **It executes shell commands and writes files on your
machine, driven by a language model.** That is the product, not a bug, but it means the safety
boundary is narrower than most desktop apps. Be deliberate about what you point it at.

### What is confined

The file tools — `read_file`, `write_file`, `edit_file`, `list_dir` — resolve every path against
the workspace folder you pick and reject anything that escapes it, including via `..` or an
absolute path.

### What is not confined

**`run_command` is not sandboxed.** It runs in your login shell with your full user privileges,
starting in the workspace directory. Nothing stops a command from leaving that directory,
reading files elsewhere in your home folder, installing packages, making network requests, or
deleting data. Workspace confinement applies to the *file tools* only — it is not a sandbox, and
it is not a security boundary against shell commands.

Practically: the agent can do anything you could do from a terminal.

### Approval mode defaults to automatic

By default OmniWork runs tools **without asking**. Click the 🛡 toggle in the status bar (or run
`/approve ask`) to require confirmation before every command, file write, and MCP call. Approval
prompts show a diff for file changes and the full command line for shell calls.

Turn this on when working in a repository you care about, or when running a task you have not
run before.

### Prompt injection is a live risk

The agent reads files, fetches web pages, and calls MCP tools — and everything it reads enters
its context. A hostile `README`, a poisoned web page, or a malicious MCP server can contain text
that instructs the model to run commands you never asked for. Model output is not a trusted
channel.

The practical mitigations, in order of effectiveness:

1. Use approval mode when the agent will touch untrusted content
2. Point the workspace at a specific project, not your home directory
3. Only connect MCP servers you trust — they run as local subprocesses with your privileges
4. Prefer a VM or container for genuinely untrusted repositories

### Network and data

- The gateway binds **loopback only** (`127.0.0.1:20128`). It is not reachable from your network.
- Provider API keys are stored encrypted by OmniRoute in its local data directory.
- Prompts and file contents are sent to whichever model provider `auto` routing selects. Free
  providers vary in their data-retention policies — **do not send secrets or proprietary code
  through free-tier models** without checking the provider's terms.
- OmniWork itself has no telemetry and phones home to nothing.

### Unsigned builds

Release binaries are not code-signed or notarized. macOS and Windows will warn you, and you have
no cryptographic assurance the download is unmodified beyond the SHA-256 published in the release
notes. Verify it if that matters to you:

```bash
shasum -a 256 ~/Downloads/OmniWork-0.9.1-arm64.dmg
```

Building from source avoids this entirely.

## Supported versions

Only the latest release receives fixes. There are no long-term support branches.

| Version | Supported |
|---------|-----------|
| 0.9.x   | ✅        |
| < 0.9   | ❌        |
