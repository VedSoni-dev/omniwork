"use strict";
// macOS (and Linux .desktop) launchers do NOT give a GUI app the PATH you see in
// your terminal — an app opened from Finder/Dock inherits roughly
// `/usr/bin:/bin:/usr/sbin:/sbin`. That silently breaks everything we shell out
// to: `npx` for MCP servers, `node`, and any toolchain the agent's run_command
// needs (homebrew, nvm, pyenv, cargo, …).
//
// So on first use we ask the user's real login shell what its PATH is and merge
// that into process.env, once, for the lifetime of the process. Child processes
// spawned later (MCP servers, run_command) inherit the repaired value.
//
// No-op on Windows, and no-op when we were launched from a terminal that already
// handed us a reasonable PATH.

const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const MARKER = "__OMNIWORK_PATH__";

// Paths worth having even if the shell probe fails entirely.
function fallbackDirs() {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin", "/opt/homebrew/sbin", // Apple Silicon homebrew
    "/usr/local/bin", "/usr/local/sbin",       // Intel homebrew + misc
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".volta", "bin"),
    "/opt/local/bin",                          // MacPorts
  ];
}

// Ask the login shell for its PATH. Interactive (-i) so that nvm/pyenv shims set
// up in ~/.zshrc are included, which a plain login shell would miss.
function probeShellPath() {
  const shell = process.env.SHELL || "/bin/zsh";
  if (!fs.existsSync(shell)) return null;
  try {
    const out = execFileSync(shell, ["-ilc", `printf "${MARKER}%s${MARKER}" "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,          // a misbehaving rc file must not hang app startup
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TERM: "dumb" },
    });
    const m = out.split(MARKER);
    return m.length >= 2 && m[1].trim() ? m[1].trim() : null;
  } catch {
    return null; // shell missing, rc file exploded, or timed out — use fallbacks
  }
}

let applied = false;

function ensureShellPath() {
  if (applied || process.platform === "win32") return process.env.PATH;
  applied = true;

  const seen = new Set();
  const merged = [];
  const add = (dir) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    merged.push(dir);
  };

  // Shell's own PATH wins, then whatever we were launched with, then fallbacks.
  const probed = probeShellPath();
  if (probed) probed.split(path.delimiter).forEach(add);
  (process.env.PATH || "").split(path.delimiter).forEach(add);
  fallbackDirs().filter((d) => fs.existsSync(d)).forEach(add);

  process.env.PATH = merged.join(path.delimiter);
  return process.env.PATH;
}

module.exports = { ensureShellPath };
