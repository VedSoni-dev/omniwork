"use strict";
// Wires OmniWork into Claude Code (and other MCP clients) as a delegate target.
//
//   npm run connect              # show what would change, then ask
//   npm run connect -- --yes     # non-interactive (CI, dotfiles, scripts)
//   npm run connect -- --uninstall
//
// Deliberately NOT a postinstall hook. This touches ~/.claude.json and the global
// CLAUDE.md, which shape every Claude Code session on the machine — that is not a
// thing to do silently because someone ran `npm install`. It is opt-in, it prints
// exactly what it will change before touching anything, every edit is idempotent,
// and --uninstall removes precisely what was added.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "electron", "mcp-server.js");

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CLAUDE_MD = path.join(CLAUDE_DIR, "CLAUDE.md");
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");

const BEGIN = "<!-- BEGIN OMNIWORK -- managed by `npm run connect`; edits inside are overwritten -->";
const END = "<!-- END OMNIWORK -->";

const args = process.argv.slice(2);
const UNINSTALL = args.includes("--uninstall");
const ASSUME_YES = args.includes("--yes") || args.includes("-y");

const ok = (m) => console.log(`  ✅ ${m}`);
const info = (m) => console.log(`  ·  ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

// ── the guidance block ──────────────────────────────────────────────
// Kept tight on purpose: this loads into every session's context. Depth lives
// in the omniwork skill (~/.claude/skills/omniwork/), loaded on demand.
function guidance() {
  return `${BEGIN}

## OmniWork (free-model delegation + browsing)

The \`omniwork\` MCP server runs work on **free** models via a local gateway. Offload mechanical
work so your context and tokens go to the reasoning that needs them. For the full situation
guide, load the \`omniwork\` skill.

- \`delegate(task, cwd)\` — one subtask, autonomous; returns summary + change list
- \`delegate_parallel(tasks[], cwd)\` — independent subtasks fanned out at once; prefer over N delegate calls
- \`web_search(query)\` / \`browse_page(url)\` — search and read pages through OmniWork (no API key)
- \`list_skills()\` / \`install_skills(source)\` — see or extend what delegated agents can do

Rules of thumb: always pass \`cwd\`; delegated agents start **cold** (self-contained prompts only);
~30 s overhead per call, so don't delegate tiny things; not a sandbox — it edits real files with
full user privileges, so avoid destructive or precision-critical tasks; **verify results yourself**
(run the test, read the diff) — summaries are claims, not evidence.

${END}`;
}

// ── the skill (depth on demand) ─────────────────────────────────────
const SKILL_DIR = path.join(CLAUDE_DIR, "skills", "omniwork");

function skillBody() {
  return `---
name: omniwork
description: Delegate coding/research work to free local models via the omniwork MCP server, browse the web through it, and manage its skills. Load when deciding whether/how to delegate, when a delegation misbehaves, or when the user mentions OmniWork.
---

# Using OmniWork — every situation

OmniWork executes tasks autonomously on free models through a local gateway. The expensive
model (you) orchestrates; OmniWork does the grunt work. Tools: \`delegate\`, \`delegate_parallel\`,
\`web_search\`, \`browse_page\`, \`list_skills\`, \`install_skills\`.

## When to delegate
- Bulk mechanical work: boilerplate, scaffolding, repetitive edits, test skeletons, doc stubs
- Independent chunks → \`delegate_parallel\` (one call, many tasks), never N sequential calls
- Read-heavy research: summarizing long files/sites so they never enter your context
- Anything cheap to verify after the fact

## When NOT to delegate
- Needs conversation context — delegates start cold; if a self-contained prompt costs more than
  the work, do the work yourself
- Small tasks (~30 s overhead per call)
- Precision-critical specs — free models drift on instruction details
- Destructive, security-sensitive, or hard-to-undo changes — OmniWork is NOT a sandbox; it edits
  real files and runs real commands with the user's privileges

## How to write a delegation
1. Always pass \`cwd\` (absolute). 2. Self-contained prompt: include file paths, exact
requirements, and acceptance criteria — the agent cannot see your conversation. 3. Ask for a
verifiable artifact ("create X, run Y, report the output"). 4. On a repo that matters, start
from a clean tree so changes review as a diff.

## After a delegation
Treat the summary as a claim, not evidence: run the test, execute the file, read the diff before
reporting the work as done. If the result is wrong, either fix it yourself (small gaps) or
re-delegate with the failure pasted into a sharper prompt (systematic misses).

## Skills & memory (what delegated agents know)
Delegated agents load OmniWork's installed skills (Claude Code-compatible SKILL.md format) and
its saved memory (global + per-project) — they improve as the user teaches OmniWork.
- \`list_skills()\` first when unsure what it can do well
- \`install_skills("owner/repo" | git URL | folder)\` to add capabilities; only SKILL.md
  directories are copied, nothing executes at install time. Confirm with the user before
  installing from sources they didn't name.
- To make future delegations remember a fact, include "save this to memory: …" in the task.

## Browsing
- \`web_search(query)\` — DuckDuckGo results (titles, URLs, snippets); no API key
- \`browse_page(url)\` — static fetch in this server (JavaScript NOT rendered). For JS-heavy
  pages, delegate the browsing: with the OmniWork desktop app running, delegated agents render
  pages in a real Chromium browser.

## Troubleshooting
- First call is slow → the gateway is booting (~10-30 s); later calls reuse it. Keeping the
  OmniWork desktop app open makes every call warm.
- "Engine still starting" or timeouts → wait a few seconds and retry once; if it persists, tell
  the user to run \`npm run doctor\` in the omniwork checkout.
- Empty/garbled results → free-model routing varies; retry once, then narrow the task or do it
  yourself. Do not silently ship unverified delegated output.
`;
}

function writeSkill() {
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.writeFileSync(path.join(SKILL_DIR, "SKILL.md"), skillBody(), "utf8");
  ok(`installed the omniwork skill at ${tildify(SKILL_DIR)}`);
}

function removeSkill() {
  if (!fs.existsSync(SKILL_DIR)) { info("omniwork skill not installed — nothing to remove"); return; }
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  ok("removed the omniwork skill");
}

// ── prompting ───────────────────────────────────────────────────────
function confirm(question) {
  if (ASSUME_YES) return Promise.resolve(true);
  if (!process.stdin.isTTY) {
    console.log("\nNot a TTY and --yes was not passed; making no changes.");
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.omniwork-backup`;
  fs.copyFileSync(file, dest);
  return dest;
}

// ── CLAUDE.md ───────────────────────────────────────────────────────
function claudeMdState() {
  if (!fs.existsSync(CLAUDE_MD)) return "absent";
  const s = fs.readFileSync(CLAUDE_MD, "utf8");
  return s.includes(BEGIN) ? "managed" : "exists";
}

function writeClaudeMd() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const state = claudeMdState();
  const block = guidance();

  if (state === "absent") {
    fs.writeFileSync(CLAUDE_MD, block + "\n", "utf8");
    ok(`created ${tildify(CLAUDE_MD)}`);
    return;
  }

  const cur = fs.readFileSync(CLAUDE_MD, "utf8");
  const b = backup(CLAUDE_MD);
  if (state === "managed") {
    // Replace between markers, leaving everything the user wrote untouched.
    const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`);
    fs.writeFileSync(CLAUDE_MD, cur.replace(re, block), "utf8");
    ok(`updated the OmniWork section in ${tildify(CLAUDE_MD)}`);
  } else {
    fs.writeFileSync(CLAUDE_MD, cur.trimEnd() + "\n\n" + block + "\n", "utf8");
    ok(`appended to ${tildify(CLAUDE_MD)} (your existing content is untouched)`);
  }
  if (b) info(`backup: ${tildify(b)}`);
}

function removeClaudeMd() {
  if (claudeMdState() !== "managed") { info("no OmniWork section in CLAUDE.md — nothing to remove"); return; }
  const cur = fs.readFileSync(CLAUDE_MD, "utf8");
  backup(CLAUDE_MD);
  const re = new RegExp(`\\n*${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n*`);
  const next = cur.replace(re, "\n").trim();
  if (!next) {
    fs.unlinkSync(CLAUDE_MD);
    ok(`removed ${tildify(CLAUDE_MD)} (it held only the OmniWork section)`);
  } else {
    fs.writeFileSync(CLAUDE_MD, next + "\n", "utf8");
    ok(`removed the OmniWork section from ${tildify(CLAUDE_MD)}`);
  }
}

// ── MCP registration ────────────────────────────────────────────────
function hasClaudeCli() {
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function mcpRegistered() {
  try {
    const c = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
    return Boolean(c.mcpServers && c.mcpServers.omniwork);
  } catch { return false; }
}

function registerMcp() {
  // Prefer the CLI — it owns the config format and will keep working if it changes.
  if (hasClaudeCli()) {
    try {
      if (mcpRegistered()) execFileSync("claude", ["mcp", "remove", "--scope", "user", "omniwork"], { stdio: "ignore" });
      execFileSync("claude", ["mcp", "add", "--scope", "user", "omniwork", "--", process.execPath, SERVER], { stdio: "ignore" });
      ok("registered the omniwork MCP server with Claude Code (user scope)");
      return true;
    } catch (e) {
      warn(`claude mcp add failed (${e.message.split("\n")[0]}) — falling back to a direct edit`);
    }
  }
  // Fallback: edit ~/.claude.json ourselves, with a backup. That file holds a lot of
  // unrelated state, so we only touch the one key and never rewrite it from scratch.
  try {
    let conf = {};
    if (fs.existsSync(CLAUDE_JSON)) { backup(CLAUDE_JSON); conf = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")); }
    conf.mcpServers = conf.mcpServers || {};
    conf.mcpServers.omniwork = { type: "stdio", command: process.execPath, args: [SERVER], env: {} };
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(conf, null, 2), "utf8");
    ok(`registered the omniwork MCP server in ${tildify(CLAUDE_JSON)}`);
    return true;
  } catch (e) {
    warn(`could not register automatically: ${e.message}`);
    console.log(`\n     Add this to your MCP client's config manually:\n`);
    console.log(`     "omniwork": { "command": "${process.execPath}", "args": ["${SERVER}"] }\n`);
    return false;
  }
}

function unregisterMcp() {
  if (hasClaudeCli() && mcpRegistered()) {
    try { execFileSync("claude", ["mcp", "remove", "--scope", "user", "omniwork"], { stdio: "ignore" }); ok("removed the omniwork MCP server"); return; }
    catch {}
  }
  if (!mcpRegistered()) { info("omniwork MCP server not registered — nothing to remove"); return; }
  try {
    backup(CLAUDE_JSON);
    const conf = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
    delete conf.mcpServers.omniwork;
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(conf, null, 2), "utf8");
    ok("removed the omniwork MCP server");
  } catch (e) { warn(`could not remove automatically: ${e.message}`); }
}

// ── helpers ─────────────────────────────────────────────────────────
const tildify = (p) => p.replace(os.homedir(), "~");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── main ────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(SERVER)) {
    console.error(`\nCannot find ${SERVER} — run this from inside the omniwork checkout.\n`);
    process.exit(1);
  }

  if (UNINSTALL) {
    console.log("\nDisconnect OmniWork from Claude Code\n");
    console.log("This will:");
    console.log(`  · remove the omniwork MCP server from ${tildify(CLAUDE_JSON)}`);
    console.log(`  · remove the OmniWork section from ${tildify(CLAUDE_MD)}`);
    console.log("  · leave a .omniwork-backup beside anything it edits\n");
    if (!(await confirm("Proceed?"))) { console.log("\nNothing changed.\n"); process.exit(0); }
    console.log();
    unregisterMcp();
    removeClaudeMd();
    removeSkill();
    console.log("\nDisconnected. Restart Claude Code for it to take effect.\n");
    return;
  }

  const state = claudeMdState();
  console.log("\nConnect OmniWork to Claude Code\n");
  console.log("Lets Claude Code delegate mechanical work to OmniWork's free models.\n");
  console.log("This will:");
  console.log(`  · register an MCP server named "omniwork" for your user`);
  console.log(`    ${process.execPath} ${SERVER}`);
  if (state === "absent") console.log(`  · create ${tildify(CLAUDE_MD)} with guidance on when to delegate`);
  else if (state === "managed") console.log(`  · update the existing OmniWork section in ${tildify(CLAUDE_MD)}`);
  else console.log(`  · append a delegate section to ${tildify(CLAUDE_MD)} (existing content untouched)`);
  console.log(`  · install the omniwork skill at ${tildify(SKILL_DIR)} (full usage guide, loaded on demand)`);
  console.log("  · leave a .omniwork-backup beside anything it edits");
  console.log("\nBoth are global: they affect every Claude Code session for your user.");
  console.log("Undo at any time with:  npm run connect -- --uninstall\n");

  if (!(await confirm("Proceed?"))) { console.log("\nNothing changed.\n"); process.exit(0); }
  console.log();
  registerMcp();
  writeClaudeMd();
  writeSkill();

  console.log("\nDone. Restart Claude Code, then try:");
  console.log('  "delegate writing the tests for X to omniwork"\n');
  console.log("Tip: keep the OmniWork desktop app running and delegated calls reuse its");
  console.log("warm gateway instead of booting a new one.\n");
})();
