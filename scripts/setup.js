"use strict";
// One-command setup:  npm run setup
//
//   1. doctor  — verify Node, repair a half-extracted Electron, generate the icon
//   2. connect — optionally wire OmniWork into Claude Code as a delegate target
//
// Step 2 is offered, never assumed: it edits global config that affects every
// Claude Code session. Pass --yes to accept both non-interactively, or --no-connect
// to do setup only.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const SKIP_CONNECT = args.includes("--no-connect");
const ASSUME_YES = args.includes("--yes") || args.includes("-y");

function run(script, extra = []) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...extra], { stdio: "inherit" }).status;
}

const code = run("doctor.js");
if (code !== 0) {
  console.log("Setup stopped: fix the problems above, then run `npm run setup` again.\n");
  process.exit(code);
}

if (SKIP_CONNECT) {
  console.log("Skipping Claude Code integration (--no-connect).");
  console.log("Run `npm run connect` later if you want it.\n");
  process.exit(0);
}

console.log("─".repeat(64));
process.exit(run("connect.js", ASSUME_YES ? ["--yes"] : []));
