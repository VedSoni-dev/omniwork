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

const fs = require("node:fs");
const { ensureShellPath } = require("./shell-path");
const { Agent } = require("./agent");
const { agentEnv, browser, ensureGateway, prewarmGateway, SKILLS_DIR } = require("./headless");
const skillsApi = require("./skills");

ensureShellPath(); // MCP clients can launch us with a minimal environment too

const log = (...a) => process.stderr.write("[omniwork-mcp] " + a.join(" ") + "\n");

// A backstop, not a work budget: a free model that stalls mid-turn used to hang
// the caller until *its* client timeout, with nothing to show for it. On expiry
// we abort the agent and return whatever it managed to finish.
const DELEGATE_TIMEOUT_MS = Number(process.env.OMNIWORK_DELEGATE_TIMEOUT_MS || 600_000);

// Run one delegated task; capture a change log + final summary.
async function runDelegate({ task, cwd, progress }) {
  const gw = await ensureGateway(log);
  const workspace = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const changes = [];
  let steps = 0;
  const agent = new Agent({
    baseUrl: gw.baseUrl, apiKey: gw.apiKey, model: process.env.OMNIWORK_MODEL || "auto",
    workspace, canSpawn: true, ...agentEnv(workspace),
    // The caller sees a single tool result, never the token stream.
    streaming: false,
    emit: (type, p) => {
      if (type === "thinking") progress(++steps, "thinking…");
      else if (type === "tool_call") {
        if (p.name === "write_file") changes.push(`wrote ${p.args.path}`);
        else if (p.name === "edit_file") changes.push(`edited ${p.args.path}`);
        else if (p.name === "run_command") changes.push(`ran: ${String(p.args.command).slice(0, 80)}`);
        progress(steps, `${p.name} ${String(p.args.path || p.args.command || p.args.query || "").slice(0, 60)}`.trim());
      }
    },
  });

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; agent.abort(); }, DELEGATE_TIMEOUT_MS);
  try { await agent.send(task); }
  finally { clearTimeout(timer); }

  const summary = agent.lastText || "(no summary)";
  const changeLog = changes.length ? `\n\nChanges:\n- ${changes.join("\n- ")}` : "";
  const note = timedOut ? `\n\n[stopped after ${Math.round(DELEGATE_TIMEOUT_MS / 1000)}s — this is partial work]` : "";
  return `${summary}${changeLog}${note}`;
}

const TOOLS = [
  {
    name: "delegate",
    description:
      "Delegate ONE coding/research subtask to OmniWork, which executes it autonomously on FREE models (reads/writes/edits files, runs commands, browses the web) in the given working directory and returns a summary + change list. The agent has OmniWork's installed skills and remembers facts saved to its memory across delegations. USE for: mechanical/boilerplate work, scaffolding, repetitive edits, read-heavy research, anything cheap to verify. DON'T use for: tasks needing the current conversation's context (delegates start cold — write fully self-contained instructions), tiny tasks (~30s overhead), precision-critical specs, or destructive/hard-to-undo changes. Always pass cwd. Verify the result yourself — the summary is a claim, not evidence.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Full, self-contained instruction. Include every fact the agent needs — it cannot see your conversation." },
        cwd: { type: "string", description: "Absolute working directory. Always pass this explicitly." },
      },
      required: ["task"],
    },
  },
  {
    name: "delegate_parallel",
    description:
      "Delegate MANY independent subtasks at once; OmniWork fans them out to parallel free-model subagents and returns all summaries. USE instead of N sequential delegate calls whenever tasks don't depend on each other (write N files, refactor N modules, research N topics). Each task must be fully self-contained.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "string" }, description: "Independent, self-contained subtask instructions." },
        cwd: { type: "string", description: "Absolute working directory. Always pass this explicitly." },
      },
      required: ["tasks"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web through OmniWork (DuckDuckGo, no API key). Returns titles, URLs, and snippets. USE when you need current information or to locate a page/repo without spending a delegation.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "browse_page",
    description:
      "Fetch a page's readable text and links through OmniWork. In this server it is a static fetch (JavaScript not rendered) — for JS-heavy pages, delegate the browsing task instead: delegated agents render pages in a real browser when the OmniWork app is running.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "list_skills",
    description:
      "List the skills OmniWork has installed (name + description + scope). Check this to know what delegated agents are good at, or before installing something that may already exist.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "install_skills",
    description:
      "Install skills into OmniWork's global environment from a git URL, GitHub owner/repo, or local folder. Only SKILL.md directories are copied — nothing from the source is executed. Newly installed skills apply to all subsequent delegations. Ask the user before installing from sources they didn't name.",
    inputSchema: { type: "object", properties: { source: { type: "string", description: "Git URL, owner/repo, or local folder path." } }, required: ["source"] },
  },
];

async function callTool(name, args, progress = () => {}) {
  if (name === "delegate") return await runDelegate({ task: args.task, cwd: args.cwd, progress });
  if (name === "delegate_parallel") {
    const gw = await ensureGateway(log);
    const workspace = args.cwd && fs.existsSync(args.cwd) ? args.cwd : process.cwd();
    let done = 0;
    const tasks = (args.tasks || []).map((t, i) => ({ title: `task ${i + 1}`, prompt: t }));
    const agent = new Agent({
      baseUrl: gw.baseUrl, apiKey: gw.apiKey, model: process.env.OMNIWORK_MODEL || "auto",
      workspace, canSpawn: true, ...agentEnv(workspace), streaming: false,
      emit: (type, p) => {
        if (type !== "subagent") return;
        if (p.kind === "done") progress(++done, `${done}/${tasks.length} subagents finished`, tasks.length);
        else if (p.kind === "tool") progress(done, `${p.title || "subagent"}: ${p.tool}`, tasks.length);
      },
    });
    return await agent.runSubagents(tasks);
  }
  if (name === "web_search") return await browser.search(args.query);
  if (name === "browse_page") return await browser.open(args.url);
  if (name === "list_skills") {
    const list = skillsApi.listSkills(SKILLS_DIR, process.cwd());
    return list.length
      ? list.map((s) => `- ${s.name} (${s.scope}): ${s.description || "(no description)"}`).join("\n")
      : "No skills installed yet. Install some with install_skills (e.g. anthropics/skills).";
  }
  if (name === "install_skills") {
    const installed = await skillsApi.installSkills(SKILLS_DIR, args.source);
    return installed.length
      ? `Installed skills: ${installed.join(", ")}. They apply to all subsequent delegations.`
      : "No SKILL.md directories found at that source.";
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
    // Boot OmniRoute now, in the background. It used to start on the first
    // delegate call, so the caller paid the whole cold-start (tens of seconds,
    // or an engine download on lite builds) before any work began. Starting here
    // overlaps it with the host reading our tool list and deciding what to do.
    prewarmGateway(log);
    reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "omniwork", version: require("../package.json").version } });
  } else if (method === "notifications/initialized") {
    // no-op
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    // Delegation is long-running; without progress the host just sees a silent
    // block and no way to tell "working" from "hung".
    const token = params && params._meta && params._meta.progressToken;
    const progress = (n, message, total) => {
      if (token === undefined || token === null) return;
      sendMsg({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: n, ...(total ? { total } : {}), message } });
    };
    try {
      const text = await callTool(params.name, params.arguments || {}, progress);
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
