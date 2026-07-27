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
// Kept tight on purpose: this loads into every session's context, so a bloated
// token-saving doc would defeat its own point.
function guidance() {
  return `${BEGIN}

## Delegating to OmniWork (token saver)

The \`omniwork\` MCP server runs coding tasks on **free** models via a local gateway. Use it to
offload mechanical work so context and tokens go to the reasoning that needs them.

- \`delegate(task, cwd?)\` — one subtask, autonomously; returns a summary + change list
- \`delegate_parallel(tasks[], cwd?)\` — independent subtasks fanned out at once

Always pass \`cwd\` explicitly. It reads and writes real files and runs shell commands there with
full user privileges — it is not a sandbox.

**Delegate when:** bulk mechanical work (boilerplate, scaffolding, repetitive edits); independent
chunks that can run in parallel (use \`delegate_parallel\`, not N sequential calls); read-heavy
research to keep long documents out of context; anything cheap to verify.

**Don't delegate when:**
- **It needs conversation context.** Delegated agents start cold — they cannot see the current
  conversation or anything already read. Prompts must be fully self-contained, and if writing
  that prompt costs more than doing the work, just do the work.
- **The task is small.** There is ~25-30 s of overhead per call.
- **Precision matters.** Free models drift on instruction details — fine for scaffolding, bad for
  exact specs.
- **It is destructive, security-sensitive, or hard to undo.**

**Treat the returned summary as a claim, not evidence.** Verify before reporting work as done —
run the test, execute the file, read the diff. Summaries tend to be rosier than reality.

It writes directly to the working tree, so on a repo that matters, start from a clean tree to keep
the changes reviewable as a diff.

${END}`;
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
  console.log("  · leave a .omniwork-backup beside anything it edits");
  console.log("\nBoth are global: they affect every Claude Code session for your user.");
  console.log("Undo at any time with:  npm run connect -- --uninstall\n");

  if (!(await confirm("Proceed?"))) { console.log("\nNothing changed.\n"); process.exit(0); }
  console.log();
  registerMcp();
  writeClaudeMd();

  console.log("\nDone. Restart Claude Code, then try:");
  console.log('  "delegate writing the tests for X to omniwork"\n');
  console.log("Tip: keep the OmniWork desktop app running and delegated calls reuse its");
  console.log("warm gateway instead of booting a new one.\n");
})();
