#!/usr/bin/env node
"use strict";
// OmniWork as an ACP AGENT (Agent Client Protocol v1).
//
// Where mcp-server.js lets a premium agent delegate *into* OmniWork as a tool,
// this exposes OmniWork as a first-class coding agent that any ACP client can
// drive: OpenClaw, acpx, Zed, Neovim — the harness owns the UI, OmniWork does
// the work on free models via the bundled OmniRoute gateway.
//
// Wire it into acpx (~/.acpx/config.json or <repo>/.acpxrc.json):
//   { "agents": { "omniwork": { "argv": ["npx", "-y", "omniwork-acp"] } } }
// …or OpenClaw (openclaw.json):
//   plugins.entries.acpx.config.agents.omniwork = { command: "npx", args: ["-y","omniwork-acp"] }
//
// Speaks JSON-RPC 2.0 over stdio (newline-delimited), bidirectionally: unlike
// the MCP server we also send *requests* to the client (session/request_permission),
// so outbound ids get a pending map.
//
// stdout is reserved for the protocol; all logging goes to stderr.

const fs = require("node:fs");
const path = require("node:path");
const { ensureShellPath } = require("./shell-path");
const { Agent } = require("./agent");
const { agentEnv, ensureGateway, prewarmGateway, DATA_DIR, SKILLS_DIR } = require("./headless");
const skillsApi = require("./skills");

ensureShellPath(); // ACP clients can launch us with a minimal environment too

const PROTOCOL_VERSION = 1;
const VERSION = require("../package.json").version;
const log = (...a) => process.stderr.write("[omniwork-acp] " + a.join(" ") + "\n");
const STORE_DIR = path.join(DATA_DIR, "acp-sessions");

// OmniWork's approval modes, as ACP session modes. `ask` is the default: the
// whole point of ACP is that the client owns the permission boundary, so we let
// it prompt rather than silently running commands in someone's editor.
const MODES = [
  { id: "ask", name: "Ask", description: "Ask before file edits and commands." },
  { id: "edits", name: "Accept edits", description: "Auto-accept file edits; ask before commands." },
  { id: "auto", name: "Auto", description: "Run everything without asking." },
  { id: "plan", name: "Plan", description: "Explore and design only — no changes." },
];
const DEFAULT_MODE = MODES.some((m) => m.id === process.env.OMNIWORK_ACP_MODE)
  ? process.env.OMNIWORK_ACP_MODE
  : "ask";

const TOOL_KIND = {
  list_dir: "read", read_file: "read", read_knowledge: "read", use_skill: "read",
  write_file: "edit", edit_file: "edit",
  run_command: "execute",
  web_search: "search",
  web_fetch: "fetch", browse_page: "fetch", open_url: "fetch",
  spawn_subagents: "think",
};

function toolTitle(name, args = {}) {
  switch (name) {
    case "run_command": return String(args.command || "").slice(0, 120) || "run command";
    case "read_file": return `Read ${args.path}`;
    case "write_file": return `Write ${args.path}`;
    case "edit_file": return `Edit ${args.path}`;
    case "list_dir": return `List ${args.path || "."}`;
    case "web_search": return `Search "${String(args.query || "").slice(0, 80)}"`;
    case "web_fetch": case "browse_page": return `Fetch ${args.url}`;
    case "open_url": return `Open ${args.url}`;
    case "spawn_subagents": return `Fan out to ${(args.tasks || []).length} subagents`;
    case "use_skill": return `Skill: ${args.name}`;
    case "save_skill": return `Save skill: ${args.name}`;
    case "save_memory": return `Remember: ${args.title || ""}`;
    case "install_skills": return `Install skills from ${args.source}`;
    default: return name;
  }
}

// ACP renders `diff` tool content natively, so edits show up as real diffs in the
// client instead of "Wrote 412 bytes". Computed at tool_call time — before the
// write lands — because that's the only moment the old content still exists.
function diffFor(workspace, name, args = {}) {
  if (name !== "write_file" && name !== "edit_file") return null;
  try {
    if (!args.path) return null;
    const abs = path.resolve(workspace, args.path);
    const old = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (name === "write_file") return [{ type: "diff", path: abs, oldText: old, newText: String(args.content ?? "") }];
    if (old != null && args.old_string != null && old.includes(args.old_string)) {
      return [{ type: "diff", path: abs, oldText: old, newText: old.replace(args.old_string, args.new_string ?? "") }];
    }
  } catch {}
  return null;
}

function locationsFor(workspace, args = {}) {
  if (!args.path) return undefined;
  try { return [{ path: path.resolve(workspace, args.path) }]; } catch { return undefined; }
}

// ContentBlock[] → the (text, images) pair Agent.send expects.
function decodePrompt(blocks) {
  const parts = [];
  const images = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") parts.push(b.text || "");
    else if (b.type === "image" && b.data) images.push(`data:${b.mimeType || "image/png"};base64,${b.data}`);
    else if (b.type === "resource_link") parts.push(`${b.name || b.uri} (${b.uri})`);
    else if (b.type === "resource" && b.resource) {
      const r = b.resource;
      if (typeof r.text === "string") parts.push(`\n--- ${r.uri || "attached file"} ---\n${r.text}\n---`);
      else if (r.uri) parts.push(String(r.uri));
    }
  }
  return { text: parts.join("\n").trim(), images };
}

// ── JSON-RPC plumbing (bidirectional) ─────────────────────────────
let outSeq = 0;
const pendingOut = new Map(); // our request id -> {resolve, reject}

function write(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function notify(method, params) { write({ jsonrpc: "2.0", method, params }); }
function callClient(method, params) {
  const id = `ow${++outSeq}`;
  return new Promise((resolve, reject) => {
    pendingOut.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ── sessions ──────────────────────────────────────────────────────
const sessions = new Map();
let sessionSeq = 0;
let msgReplaySeq = 0;

function sessionFile(id) { return path.join(STORE_DIR, id + ".json"); }

function persist(sess) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(sessionFile(sess.id), JSON.stringify({
      id: sess.id, cwd: sess.cwd, mode: sess.mode,
      messages: sess.agent.messages.slice(-200),
    }));
  } catch (e) { log("persist failed:", e.message); }
}

async function buildSession({ id, cwd, mode, messages }) {
  const gw = await ensureGateway(log);
  const sess = {
    id, cwd, mode: mode || DEFAULT_MODE,
    sink: () => {},                 // replaced per turn
    approve: async () => false,     // replaced per turn
    pendingPermissions: new Set(),
    agent: null,
  };
  sess.agent = new Agent({
    baseUrl: gw.baseUrl,
    apiKey: gw.apiKey,
    model: process.env.OMNIWORK_MODEL || "auto",
    workspace: cwd,
    canSpawn: true,
    approvalMode: sess.mode,
    approver: (callId, name, args, preview) => sess.approve(callId, name, args, preview),
    emit: (type, payload) => sess.sink(type, payload),
    ...agentEnv(cwd),
  });
  if (Array.isArray(messages) && messages.length) sess.agent.messages = messages;
  sessions.set(id, sess);
  return sess;
}

// Skills become ACP slash commands, so `/deep-research` in the client's prompt
// box is the same skill the desktop app exposes.
function pushCommands(sess) {
  let list = [];
  try { list = skillsApi.listSkills(SKILLS_DIR, sess.cwd) || []; } catch {}
  notify("session/update", {
    sessionId: sess.id,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: list.slice(0, 100).map((s) => ({
        name: s.name,
        description: (s.description || `Run the ${s.name} skill.`).slice(0, 200),
        input: { hint: "optional extra instructions" },
      })),
    },
  });
}

// ── the prompt turn ───────────────────────────────────────────────
async function runTurn(sess, blocks) {
  const { text, images } = decodePrompt(blocks);
  if (!text && !images.length) return { stopReason: "end_turn" };

  const sid = sess.id;
  const up = (update) => notify("session/update", { sessionId: sid, update });
  const tools = new Map(); // OmniWork call id -> { acpId, name, args, diff }
  let toolSeq = 0;
  let msgSeq = 0;
  let messageId = `m${Date.now().toString(36)}_0`;
  let stopReason = "end_turn";
  let failure = null;

  sess.sink = (type, p) => {
    try {
      switch (type) {
        // Each model round-trip starts a new assistant message.
        case "thinking":
          messageId = `m${Date.now().toString(36)}_${++msgSeq}`;
          break;

        case "assistant_delta":
          if (p.chunk) up({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: p.chunk } });
          break;

        // `assistant` repeats what the deltas already streamed — dropping it
        // avoids showing every reply twice.
        case "assistant":
          break;

        case "system":
          up({ sessionUpdate: "agent_message_chunk", messageId: `sys${Date.now().toString(36)}`, content: { type: "text", text: String(p.content || "") } });
          break;

        case "tool_call": {
          const acpId = `t${++toolSeq}`;
          const diff = diffFor(sess.cwd, p.name, p.args);
          tools.set(p.id, { acpId, name: p.name, args: p.args, diff });
          up({
            sessionUpdate: "tool_call",
            toolCallId: acpId,
            title: toolTitle(p.name, p.args),
            kind: TOOL_KIND[p.name] || "other",
            status: "pending",
            rawInput: p.args,
            ...(diff ? { content: diff } : {}),
            ...(locationsFor(sess.cwd, p.args) ? { locations: locationsFor(sess.cwd, p.args) } : {}),
          });
          break;
        }

        case "tool_stream": {
          const t = tools.get(p.id);
          if (!t || !p.chunk) break;
          up({
            sessionUpdate: "tool_call_update", toolCallId: t.acpId, status: "in_progress",
            content: [{ type: "content", content: { type: "text", text: String(p.chunk) } }],
          });
          break;
        }

        case "tool_result": {
          const t = tools.get(p.id);
          if (!t) break;
          const out = String(p.result ?? "");
          const failed = /^(Error in |Failed to |❌ Denied|⏸ Plan mode|Search failed|Browse failed|Install failed)/.test(out);
          up({
            sessionUpdate: "tool_call_update", toolCallId: t.acpId,
            status: failed ? "failed" : "completed",
            content: t.diff || [{ type: "content", content: { type: "text", text: out.slice(0, 20000) } }],
            rawOutput: { output: out.slice(0, 20000) },
          });
          break;
        }

        // The Agent Deck: each parallel subagent becomes its own ACP tool call,
        // so the client shows N live workers instead of one opaque block.
        case "subagent": {
          if (p.kind === "start") {
            const acpId = `t${++toolSeq}`;
            tools.set("sub:" + p.subId, { acpId, name: "subagent", args: {} });
            up({ sessionUpdate: "tool_call", toolCallId: acpId, title: `subagent: ${p.title}`, kind: "think", status: "in_progress" });
          } else if (p.kind === "tool" || p.kind === "text" || p.kind === "error") {
            const t = tools.get("sub:" + p.subId);
            if (!t) break;
            const line = p.kind === "tool" ? `→ ${p.tool}` : p.kind === "error" ? `error: ${p.message}` : String(p.snippet || "");
            up({
              sessionUpdate: "tool_call_update", toolCallId: t.acpId, status: "in_progress",
              content: [{ type: "content", content: { type: "text", text: line + "\n" } }],
            });
          } else if (p.kind === "done") {
            const t = tools.get("sub:" + p.subId);
            if (t) up({ sessionUpdate: "tool_call_update", toolCallId: t.acpId, status: "completed" });
          }
          break;
        }

        case "context":
          up({
            sessionUpdate: "usage_update",
            used: Math.round(((p.pct || 0) / 100) * sess.agent.contextTokens),
            size: sess.agent.contextTokens,
          });
          break;

        case "done": stopReason = "end_turn"; break;
        case "aborted": stopReason = "cancelled"; break;
        case "error":
          failure = String(p.message || "agent error");
          // "max steps" is a turn-budget stop, not a failure — ACP has a reason for it.
          if (/max steps/i.test(failure)) { stopReason = "max_turn_requests"; failure = null; }
          break;
      }
    } catch (e) { log("sink error:", e.message); }
  };

  sess.approve = async (callId, name, args) => {
    const t = tools.get(callId);
    const asked = callClient("session/request_permission", {
      sessionId: sid,
      toolCall: {
        toolCallId: t ? t.acpId : callId,
        title: toolTitle(name, args),
        kind: TOOL_KIND[name] || "other",
        status: "pending",
        rawInput: args,
        ...(t && t.diff ? { content: t.diff } : {}),
      },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "allow_always", name: "Allow, don't ask again", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    });
    // A well-behaved client answers `cancelled` on session/cancel, but a turn
    // parked here isn't inside the agent loop — so keep a local escape hatch
    // rather than depending on the client to unblock us.
    let deny;
    const settled = new Promise((resolve) => {
      deny = () => resolve(null);
      asked.then(resolve, () => resolve(null));
    });
    sess.pendingPermissions.add(deny);
    let res;
    try { res = await settled; }
    finally { sess.pendingPermissions.delete(deny); }
    if (!res) return false;

    const outcome = res.outcome;
    if (!outcome || outcome.outcome !== "selected") return false;
    if (outcome.optionId === "allow_always") {
      // "don't ask again" only makes sense as a real mode change — otherwise the
      // next call prompts again and the client looks broken.
      sess.mode = "auto";
      sess.agent.approvalMode = "auto";
      up({ sessionUpdate: "current_mode_update", currentModeId: "auto" });
      return true;
    }
    return outcome.optionId === "allow_once";
  };

  try {
    await sess.agent.send(text, images);
  } finally {
    sess.sink = () => {};
    sess.approve = async () => false;
    persist(sess);
  }

  if (failure) throw new RpcError(-32000, failure);
  return { stopReason };
}

// ── method handlers ───────────────────────────────────────────────
const handlers = {
  async initialize(params) {
    prewarmGateway(log); // overlap the OmniRoute boot with the client's setup
    const wanted = Number(params && params.protocolVersion);
    return {
      protocolVersion: Number.isFinite(wanted) && wanted < PROTOCOL_VERSION ? wanted : PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        // OmniWork's tools do their own filesystem and process work, so we never
        // call back into the client's fs/* or terminal/*.
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: "omniwork", title: "OmniWork", version: VERSION },
      authMethods: [],
    };
  },

  // No auth: the gateway is local and keyless. Declared so clients that probe
  // the method get a clean result instead of "unknown method".
  async authenticate() { return {}; },

  async "session/new"(params) {
    const cwd = params && params.cwd;
    if (!cwd || !path.isAbsolute(cwd)) throw new RpcError(-32602, "cwd must be an absolute path");
    if (!fs.existsSync(cwd)) throw new RpcError(-32602, `cwd does not exist: ${cwd}`);
    const id = `sess_${Date.now().toString(36)}_${++sessionSeq}`;
    const sess = await buildSession({ id, cwd, mode: DEFAULT_MODE });
    persist(sess);
    setTimeout(() => pushCommands(sess), 0); // after we've returned the sessionId
    return { sessionId: id, modes: { currentModeId: sess.mode, availableModes: MODES } };
  },

  async "session/load"(params) {
    const id = params && params.sessionId;
    const cwd = params && params.cwd;
    if (!id) throw new RpcError(-32602, "sessionId is required");
    let sess = sessions.get(id);
    if (!sess) {
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(sessionFile(id), "utf8")); } catch {}
      if (!saved) throw new RpcError(-32602, `unknown session: ${id}`);
      sess = await buildSession({ id, cwd: cwd || saved.cwd, mode: saved.mode, messages: saved.messages });
    }
    // ACP requires the whole conversation to be replayed as updates *before* we
    // answer the request.
    for (const m of sess.agent.messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = typeof m.content === "string"
        ? m.content
        : (Array.isArray(m.content) ? m.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n") : "");
      if (!text.trim()) continue;
      notify("session/update", {
        sessionId: id,
        update: {
          sessionUpdate: m.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          messageId: `replay${++msgReplaySeq}`,
          content: { type: "text", text },
        },
      });
    }
    pushCommands(sess);
    return { modes: { currentModeId: sess.mode, availableModes: MODES } };
  },

  async "session/prompt"(params) {
    const sess = sessions.get(params && params.sessionId);
    if (!sess) throw new RpcError(-32602, `unknown session: ${params && params.sessionId}`);
    if (sess.running) throw new RpcError(-32000, "a prompt is already running in this session");
    sess.running = true;
    try { return await runTurn(sess, params.prompt); }
    finally { sess.running = false; }
  },

  async "session/set_mode"(params) {
    const sess = sessions.get(params && params.sessionId);
    if (!sess) throw new RpcError(-32602, `unknown session: ${params && params.sessionId}`);
    const modeId = params && params.modeId;
    if (!MODES.some((m) => m.id === modeId)) throw new RpcError(-32602, `unknown mode: ${modeId}`);
    sess.mode = modeId;
    sess.agent.approvalMode = modeId;
    persist(sess);
    notify("session/update", { sessionId: sess.id, update: { sessionUpdate: "current_mode_update", currentModeId: modeId } });
    return {};
  },
};

const notifications = {
  "session/cancel"(params) {
    const sess = sessions.get(params && params.sessionId);
    if (!sess) return;
    sess.agent.abort();
    for (const deny of sess.pendingPermissions) { try { deny(); } catch {} }
  },
  "initialized"() {},
};

// ── stdio loop ────────────────────────────────────────────────────
async function handle(msg) {
  // A response to something we asked the client.
  if (msg.id != null && msg.method === undefined) {
    const p = pendingOut.get(msg.id);
    if (!p) return;
    pendingOut.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || "client error"));
    else p.resolve(msg.result);
    return;
  }

  const { id, method, params } = msg;
  if (id == null) {
    const n = notifications[method];
    if (n) { try { n(params || {}); } catch (e) { log("notification error:", e.message); } }
    return;
  }

  const h = handlers[method];
  if (!h) { write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } }); return; }
  try {
    write({ jsonrpc: "2.0", id, result: await h(params || {}) });
  } catch (e) {
    write({ jsonrpc: "2.0", id, error: { code: e.code || -32000, message: e.message } });
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => log("handler error:", e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log(`OmniWork ACP agent ready (stdio, protocol v${PROTOCOL_VERSION}, mode ${DEFAULT_MODE})`);
