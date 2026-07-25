#!/usr/bin/env node
"use strict";
// OmniWork as an MCP SERVER.
//
// Lets a premium agent (Claude Code, Codex, Cursor, …) DELEGATE token-heavy or
// parallelizable subtasks to OmniWork, which runs them on FREE models via the
// bundled OmniRoute gateway. The expensive model orchestrates; OmniWork does the
// grunt work for free. Maximum token efficiency.
//
// Wire it into Claude Code / Codex `mcpServers`:
//   { "omniwork": { "command": "node", "args": ["<path>/electron/mcp-server.js"] } }
//
// Speaks JSON-RPC 2.0 over stdio (newline-delimited). stdout is reserved for the
// protocol; all logging goes to stderr.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { ensureShellPath } = require("./shell-path");
const { Gateway } = require("./sidecar");
const { Agent } = require("./agent");

ensureShellPath(); // MCP clients can launch us with a minimal environment too

const log = (...a) => process.stderr.write("[omniwork-mcp] " + a.join(" ") + "\n");
const PORT = Number(process.env.OMNIWORK_GATEWAY_PORT || 20128);
const HOST = "127.0.0.1";

let gatewayInfo = null; // { baseUrl, apiKey }

// Reuse a gateway already running (e.g. the desktop app); else boot our own.
async function ensureGateway() {
  if (gatewayInfo) return gatewayInfo;
  try {
    const res = await fetch(`http://${HOST}:${PORT}/v1/models`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) { gatewayInfo = { baseUrl: `http://${HOST}:${PORT}/v1`, apiKey: "omniwork" }; log("reusing running gateway"); return gatewayInfo; }
  } catch {}
  log("starting bundled gateway…");
  const dataDir = path.join(os.homedir(), ".omniwork");
  fs.mkdirSync(dataDir, { recursive: true });
  const gw = new Gateway({ dataDir, onStatus: (s) => log("gateway", s.state, s.detail || "") });
  await gw.start();
  gatewayInfo = { baseUrl: gw.baseUrl, apiKey: gw.apiKey };
  return gatewayInfo;
}

// Run one delegated task; capture a change log + final summary.
async function runDelegate({ task, cwd, parallel }) {
  const gw = await ensureGateway();
  const workspace = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const changes = [];
  const agent = new Agent({
    baseUrl: gw.baseUrl, apiKey: gw.apiKey, model: process.env.OMNIWORK_MODEL || "auto",
    workspace, canSpawn: true,
    emit: (type, p) => {
      if (type === "tool_call") {
        if (p.name === "write_file") changes.push(`wrote ${p.args.path}`);
        else if (p.name === "edit_file") changes.push(`edited ${p.args.path}`);
        else if (p.name === "run_command") changes.push(`ran: ${String(p.args.command).slice(0, 80)}`);
      }
    },
  });
  await agent.send(task);
  const summary = agent.lastText || "(no summary)";
  const changeLog = changes.length ? `\n\nChanges:\n- ${changes.join("\n- ")}` : "";
  return `${summary}${changeLog}`;
}

const TOOLS = [
  {
    name: "delegate",
    description:
      "Delegate a coding/research subtask to OmniWork, which executes it autonomously on FREE models (reads/writes/edits files, runs commands, fetches the web) in the given working directory and returns a summary + list of changes. Use this to offload token-heavy or mechanical work and save your own context/tokens.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Full, self-contained instruction for the subtask." },
        cwd: { type: "string", description: "Absolute working directory (defaults to the server's cwd = your project)." },
      },
      required: ["task"],
    },
  },
  {
    name: "delegate_parallel",
    description:
      "Delegate MANY independent subtasks at once. OmniWork fans them out to parallel free-model subagents and returns all summaries. Use for batch work (e.g. write N files, refactor N modules, research N topics).",
    inputSchema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "string" }, description: "Independent subtask instructions." },
        cwd: { type: "string", description: "Absolute working directory (defaults to the server's cwd)." },
      },
      required: ["tasks"],
    },
  },
];

async function callTool(name, args) {
  if (name === "delegate") return await runDelegate({ task: args.task, cwd: args.cwd });
  if (name === "delegate_parallel") {
    const gw = await ensureGateway();
    const workspace = args.cwd && fs.existsSync(args.cwd) ? args.cwd : process.cwd();
    const agent = new Agent({ baseUrl: gw.baseUrl, apiKey: gw.apiKey, model: process.env.OMNIWORK_MODEL || "auto", workspace, canSpawn: true, emit: () => {} });
    const tasks = (args.tasks || []).map((t, i) => ({ title: `task ${i + 1}`, prompt: t }));
    return await agent.runSubagents(tasks);
  }
  throw new Error(`unknown tool: ${name}`);
}

// ── stdio JSON-RPC loop ────────────────────────────────────────────
function sendMsg(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { sendMsg({ jsonrpc: "2.0", id, result }); }
function replyErr(id, message) { sendMsg({ jsonrpc: "2.0", id, error: { code: -32000, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "omniwork", version: "0.4.0" } });
  } else if (method === "notifications/initialized") {
    // no-op
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    try {
      const text = await callTool(params.name, params.arguments || {});
      reply(id, { content: [{ type: "text", text }] });
    } catch (e) {
      reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
  } else if (id != null) {
    replyErr(id, `unknown method: ${method}`);
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => log("handler error", e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log("OmniWork MCP server ready (stdio)");
