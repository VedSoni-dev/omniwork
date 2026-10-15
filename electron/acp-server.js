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
const { agentEnv, ensureGateway, prewarmGateway, resolveModels, resolveModelsLive, listModels, invalidateModels, noModelHint, providers, makeAgent, isNoModelFailure, engineFallbackModel, opencode, DATA_DIR, SKILLS_DIR } = require("./headless");
const skillsApi = require("./skills");
const { previewEdit } = require("./tools");
const { complete, CompletionError } = require("./complete");
const { MCPManager } = require("./mcp");

ensureShellPath(); // ACP clients can launch us with a minimal environment too

const PROTOCOL_VERSION = 1;
const VERSION = require("../package.json").version;
const log = (...a) => process.stderr.write("[omniwork-acp] " + a.join(" ") + "\n");
const STORE_DIR = path.join(DATA_DIR, "acp-sessions");

// OmniWork's approval modes, as ACP session modes. `ask` is the default: the
// whole point of ACP is that the client owns the permission boundary, so we let
// it prompt rather than silently running commands in someone's editor.
const AGENT_MODES = [
  { id: "ask", name: "Ask", description: "Ask before file edits and commands." },
  { id: "edits", name: "Accept edits", description: "Auto-accept file edits; ask before commands." },
  { id: "auto", name: "Auto", description: "Run everything without asking." },
  { id: "plan", name: "Plan", description: "Explore and design only — no changes." },
];
// Not an approval mode: a session with no agent at all (see completion
// sessions below). Entering it is one-way.
const COMPLETION = { id: "completion", name: "Completion (tool-free)", description: "One request in, one completion out: no tools, no workspace, no memory or skills, and the system prompt is used verbatim. Nothing is written to disk. A session can't leave this mode." };
const MODES = [...AGENT_MODES, COMPLETION];
const isAgentMode = (id) => AGENT_MODES.some((m) => m.id === id);
const DEFAULT_MODE = MODES.some((m) => m.id === process.env.OMNIWORK_ACP_MODE)
  ? process.env.OMNIWORK_ACP_MODE
  : "ask";
const DEFAULT_AGENT_MODE = isAgentMode(DEFAULT_MODE) ? DEFAULT_MODE : "ask";

const AUTH_METHODS = [
  { id: "openrouter", name: "Connect OpenRouter (free models)", description: "Opens your browser to create a free OpenRouter key — 20 free models, 18 with tool calling. No key to paste." },
  { id: "local", name: "Use a local model server", description: "Registers Ollama, LM Studio, llama.cpp, or vLLM if one is running on this machine." },
  { id: "opencode", name: "Get OpenCode (free Zen models, no account)", description: "Downloads OpenCode's official release (~45 MB) into OmniWork's data folder — no npm, no PATH. OmniWork then runs OpenCode's own server as an engine for its free models: Nemotron 3.5 Lightning, MiMo V2.5, Big Pickle, Ling 3.0 Flash, Nemotron 3 Ultra." },
];

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
// previewEdit applies the tools' confinement: a path the write would refuse
// (a symlink out of the workspace) never has its contents sent to the client.
function diffFor(workspace, name, args = {}) {
  const p = previewEdit(workspace, name, args);
  return p ? [{ type: "diff", path: p.path, oldText: p.oldText, newText: p.newText }] : null;
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

// What the client said it can do, from `initialize`.
let clientCapabilities = {};

// What "always" remembers: a command is approved as that exact command line;
// any other tool, for the rest of the session.
const permissionKey = (name, args = {}) => name === "run_command" ? `run_command\u0000${String(args.command || "")}` : name;

// ── the client's MCP servers ──────────────────────────────────────
// session/new hands over the MCP servers the client wants the agent to use.
// This agent speaks stdio MCP (http/sse aren't advertised, so they're refused
// rather than silently dropped). They start in the background — first runs
// may download a package — and their tools join the agent's as they connect.
function sessionMcp(list) {
  if (list == null) return null;
  if (!Array.isArray(list)) throw new RpcError(-32602, "mcpServers must be an array");
  if (!list.length) return null;
  const confs = {};
  for (const sv of list) {
    if (!sv || typeof sv !== "object") throw new RpcError(-32602, "invalid MCP server entry");
    if (sv.type && sv.type !== "stdio" || sv.url) throw new RpcError(-32602, `MCP server "${sv.name}": only stdio servers are supported (mcpCapabilities http/sse are false)`);
    if (typeof sv.command !== "string" || !sv.command) throw new RpcError(-32602, `MCP server "${sv.name}": command is required`);
    const name = String(sv.name || "mcp").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "mcp";
    if (confs[name]) throw new RpcError(-32602, `duplicate MCP server name: ${name}`);
    const env = {};
    for (const e of Array.isArray(sv.env) ? sv.env : []) if (e && typeof e.name === "string") env[e.name] = String(e.value ?? "");
    confs[name] = { command: sv.command, args: Array.isArray(sv.args) ? sv.args.map(String) : [], env };
  }
  const mcp = MCPManager.ephemeral(confs);
  for (const server of mcp.servers.values()) server.start().catch(() => {});
  return mcp;
}

// Tools for capabilities the client didn't declare, when it asks for that
// (`_meta.omniwork.honorClientCapabilities`, or OMNIWORK_ACP_STRICT_CAPABILITIES=1).
// The default runs OmniWork's own tools whatever the client declares —
// clientCapabilities say what the client can do for the agent, and most
// clients declare none — so strict mode is how a client that hosts no
// filesystem or terminal keeps the agent from touching them.
function deniedByCapabilities(strict) {
  if (!strict) return null;
  const fsCaps = clientCapabilities.fs || {};
  const denied = [];
  if (!fsCaps.readTextFile) denied.push("read_file", "list_dir");
  if (!fsCaps.writeTextFile) denied.push("write_file", "edit_file");
  if (!clientCapabilities.terminal) denied.push("run_command");
  return denied;
}

// ── sessions ──────────────────────────────────────────────────────
const sessions = new Map();
let sessionSeq = 0;
let msgReplaySeq = 0;

// Session ids name files under STORE_DIR, and session/load takes them from the
// client: only the shape this server mints is accepted, so an id can never
// carry a path ("../../somewhere/else") out of the store.
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
function sessionFile(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw new RpcError(-32602, "invalid sessionId");
  return path.join(STORE_DIR, id + ".json");
}

// A working directory from the client: absolute, and an existing directory.
function checkCwd(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new RpcError(-32602, "cwd must be an absolute path");
  let stat = null;
  try { stat = fs.statSync(cwd); } catch {}
  if (!stat) throw new RpcError(-32602, `cwd does not exist: ${cwd}`);
  if (!stat.isDirectory()) throw new RpcError(-32602, `cwd is not a directory: ${cwd}`);
  return cwd;
}

// Transcripts hold whatever the agent read and ran: owner-only, like the
// directory, including those an earlier version wrote world-readable.
let storeTightened = false;
function secureStore() {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  if (storeTightened) return;
  storeTightened = true;
  try { fs.chmodSync(STORE_DIR, 0o700); } catch {}
  for (const f of fs.readdirSync(STORE_DIR)) { try { fs.chmodSync(path.join(STORE_DIR, f), 0o600); } catch {} }
}

function persist(sess) {
  if (sess.kind === "completion") return; // tool-free sessions leave no transcript
  try {
    secureStore();
    fs.writeFileSync(sessionFile(sess.id), JSON.stringify({
      id: sess.id, cwd: sess.cwd, mode: sess.mode,
      model: sess.agent.model, fallbackModels: sess.agent.fallbackModels,
      engineSession: sess.agent.isEngine ? sess.agent.sessionID : null,
      messages: sess.agent.messages.slice(-200),
    }), { mode: 0o600 });
  } catch (e) { log("persist failed:", e.message); }
}

async function buildSession({ id, cwd, mode, messages, model, fallbackModels, engineSession, mcp = null, deniedTools = null, projectFiles }) {
  const selected = resolveModels({ model, fallbackModels });
  const gw = opencode.isEngineModel(selected.model) ? { baseUrl: "http://127.0.0.1", apiKey: "" } : await ensureGateway(log);
  const models = opencode.isEngineModel(selected.model) ? selected : await resolveModelsLive(gw, { model, fallbackModels });
  const sess = {
    id, cwd, mode: isAgentMode(mode) ? mode : DEFAULT_AGENT_MODE,
    sink: () => {},                 // replaced per turn
    approve: async () => false,     // replaced per turn
    pendingPermissions: new Set(),
    allowed: new Set(),   // permission keys answered "always allow"
    rejected: new Set(),  // …and "never allow"
    mcp, deniedTools,
    projectFiles,         // false: leave out the repository's instruction files and skills
    agent: null,
  };
  sess.gw = gw;
  sess.modelContexts = models.modelContexts || {};
  attachAgent(sess, models.model, models.fallbackModels, { messages: Array.isArray(messages) && messages.length ? messages : null, sessionID: engineSession || null });
  sessions.set(id, sess);
  return sess;
}

// The session's agent: OmniWork's loop on the gateway, or the OpenCode engine
// for `opencode/…` models. Rebuilt when a model change crosses that line.
function attachAgent(sess, model, fallbackModels, { messages = null, sessionID = null } = {}) {
  const gw = sess.gw;
  sess.agent = makeAgent({
    baseUrl: gw.baseUrl,
    apiKey: gw.apiKey,
    model,
    fallbackModels,
    modelContexts: sess.modelContexts,
    messages,   // the engine carries these into its first prompt; the gateway agent restores them below
    sessionID,  // an OpenCode session to resume
    workspace: sess.cwd,
    canSpawn: true,
    approvalMode: sess.mode,
    approver: (callId, name, args, preview) => sess.approve(callId, name, args, preview),
    mcp: sess.mcp,
    deniedTools: sess.deniedTools,
    projectFiles: sess.projectFiles,
    emit: (type, payload) => sess.sink(type, payload),
    ...agentEnv(sess.cwd),
  });
  if (!sess.agent.isEngine && Array.isArray(messages) && messages.length) sess.agent.messages = messages;
  return sess.agent;
}

// ── completion sessions ───────────────────────────────────────────
// `completion` mode runs electron/complete.js: one request in, one completion
// out. Such a session never has an agent, so no tool exists to offer, call or
// approve; it keeps no history and is never written to disk. session/new
// reports `_meta.omniwork.toolFree: true` and an empty tool list, so a client
// can check before it sends untrusted text — and the mode can't be left, so a
// check made once holds for the session's lifetime.
//
// Settings come from `_meta.omniwork` on session/new (and per prompt on
// session/prompt): model, fallbackModels, system, schema, temperature,
// maxTokens, timeoutMs, numCtx. Completion never falls back to a model the
// client didn't name: a document meant for a local model must not reach a
// cloud provider because the local server hiccuped.
function positive(v, name) {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new RpcError(-32602, `${name} must be a positive number`);
  return Math.floor(n);
}

function completionSettings(o = {}, base = {}) {
  const s = { ...base };
  if (o.model != null) s.model = String(o.model).trim() || s.model;
  const fb = o.fallbackModels ?? o.fallback_models;
  if (fb != null) {
    if (!Array.isArray(fb) || fb.some((m) => typeof m !== "string")) throw new RpcError(-32602, "fallbackModels must be an array of model ids");
    s.fallbackModels = fb.map((m) => m.trim()).filter(Boolean);
  }
  if (o.system != null) {
    if (typeof o.system !== "string") throw new RpcError(-32602, "system must be a string");
    s.system = o.system;
  }
  if (o.schema != null) {
    if (typeof o.schema !== "object" || Array.isArray(o.schema)) throw new RpcError(-32602, "schema must be a JSON Schema object");
    s.schema = o.schema;
  }
  if (o.temperature != null) {
    const t = Number(o.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw new RpcError(-32602, "temperature must be between 0 and 2");
    s.temperature = t;
  }
  for (const [key, alias] of [["maxTokens", "max_tokens"], ["timeoutMs", "timeout_ms"], ["numCtx", "num_ctx"]]) {
    const v = positive(o[key] ?? o[alias], alias);
    if (v) s[key] = v;
  }
  s.model = s.model || resolveModels({ fallbackModels: [] }).model;
  s.fallbackModels = (s.fallbackModels || []).filter((m) => m !== s.model);
  for (const m of [s.model, ...s.fallbackModels]) {
    if (opencode.isEngineModel(m)) throw new RpcError(-32602, `${m} runs on the OpenCode engine, which always carries tools — pick a gateway or local model for completion`);
  }
  return s;
}

function newCompletionSession(id, cwd, settings) {
  const sess = { id, cwd, kind: "completion", mode: COMPLETION.id, agent: null, completion: settings, abort: null };
  sessions.set(id, sess);
  return sess;
}

// An agent session becoming tool-free. Its conversation so far stays saved as
// it was; from here on nothing is.
function toCompletion(sess) {
  if (sess.running) throw new RpcError(-32000, "cannot change the mode while a prompt is running");
  const settings = completionSettings({ model: sess.agent.isEngine ? undefined : sess.agent.model });
  persist(sess);
  try { sess.agent.abort(); } catch {}
  Object.assign(sess, { kind: "completion", mode: COMPLETION.id, agent: null, completion: settings, abort: null });
}

async function runCompletion(sess, params) {
  const perPrompt = (params._meta && params._meta.omniwork) || {};
  const settings = completionSettings(perPrompt, sess.completion);
  let blocks = (Array.isArray(params.prompt) ? params.prompt : []).filter((b) => b && typeof b === "object");
  let system = settings.system;
  // No system prompt configured: the first text block is it, the rest is input.
  if (system == null) {
    const i = blocks.findIndex((b) => b.type === "text");
    if (i >= 0 && blocks.length > 1) { system = String(blocks[i].text || ""); blocks = blocks.filter((_, j) => j !== i); }
  }
  const { text, images } = decodePrompt(blocks);
  if (!text && !images.length) return { stopReason: "end_turn", _meta: { omniwork: { ok: false, error: "empty prompt", toolFree: true } } };
  const user = images.length ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : text;

  const ctl = new AbortController();
  sess.abort = ctl;
  let r;
  try {
    r = await complete({ ...settings, system: system || "", user, gateway: () => ensureGateway(log), signal: ctl.signal });
  } catch (e) {
    if (e instanceof CompletionError && e.cancelled) return { stopReason: "cancelled", _meta: { omniwork: { ok: false, error: "cancelled", attempts: e.attempts || [], toolFree: true } } };
    if (e instanceof CompletionError) throw new RpcError(-32602, e.message);
    throw e;
  } finally { sess.abort = null; }
  if (r.ok && r.text) notify("session/update", { sessionId: sess.id, update: { sessionUpdate: "agent_message_chunk", messageId: `c${Date.now().toString(36)}`, content: { type: "text", text: r.text } } });
  // A model failure is not a protocol failure: the turn ends with a stop
  // reason and the details in _meta, never as a JSON-RPC error.
  const stopReason = !r.ok ? "refusal" : r.finishReason === "length" && !r.valid ? "max_tokens" : "end_turn";
  return { stopReason, _meta: { omniwork: r } };
}

// Skills become ACP slash commands, so `/deep-research` in the client's prompt
// box is the same skill the desktop app exposes.
function pushCommands(sess) {
  if (sess.kind === "completion") return; // no skills in a tool-free session
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

// ── model selection ───────────────────────────────────────────────
// The model is an ACP session config option (category "model"), so a client
// with a model picker shows the gateway's catalog and `session/set_config_option`
// switches it; the pre-config-option `session/set_model` is honored too. A
// harness without either sends `_meta.model` (and `_meta.fallbackModels`) on
// `session/new`. Whatever is chosen, the fallback chain still applies — a
// pinned model that fails falls through to the next one, and the switch is
// pushed back as a `config_option_update`.
const MAX_MODEL_OPTIONS = 300;

async function modelOption(sess) {
  if (sess.kind === "completion") {
    const { model, fallbackModels } = sess.completion;
    return {
      id: "model", name: "Model", category: "model", type: "select",
      description: "Model the completion runs on. Completion only falls back to models you named.",
      currentValue: model,
      options: [...new Set([model, ...fallbackModels])].map((id) => ({ value: id, name: id, ...(fallbackModels.includes(id) ? { description: `Fallback #${fallbackModels.indexOf(id) + 1}` } : {}) })),
    };
  }
  const current = sess.agent.model;
  const chain = sess.agent.fallbackModels;
  let catalog = [];
  try { if (!sess.agent.isEngine) catalog = await listModels(await ensureGateway(log)); } catch {}
  const options = [];
  const seen = new Set();
  let engine = [];
  if (opencode.available()) { try { engine = await opencode.getEngine().models(); } catch {} }
  for (const id of [current, ...chain, ...engine.map((m) => m.id), ...catalog]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const n = chain.indexOf(id);
    const notes = [];
    if (n >= 0) notes.push(`Fallback #${n + 1}`);
    if (id === "auto") notes.push("free pool, routed by the gateway");
    if (opencode.isEngineModel(id)) { const entry = engine.find(m => m.id === id); notes.push(`OpenCode engine · ${entry?.free ? "free" : "connected account; charges may apply"}`); }
    options.push({ value: id, name: id, ...(notes.length ? { description: notes.join(" · ") } : {}) });
    if (options.length >= MAX_MODEL_OPTIONS) break;
  }
  return {
    id: "model", name: "Model", category: "model", type: "select",
    description: "Model the agent runs on. If it fails (retired id, provider key, quota) OmniWork continues on the next model in its fallback chain.",
    currentValue: current, options,
  };
}

// The mode as a config option too (modes are giving way to config options).
function modeOption(sess) {
  const options = sess.kind === "completion" ? [COMPLETION] : MODES;
  return {
    id: "mode", name: "Mode", category: "mode", type: "select",
    description: "How the session runs: an approval mode for the agent, or tool-free completion (one-way).",
    currentValue: sess.mode, options: options.map((m) => ({ value: m.id, name: m.name, description: m.description })),
  };
}

const modesFor = (sess) => ({ currentModeId: sess.mode, availableModes: sess.kind === "completion" ? [COMPLETION] : MODES });

async function configOptionsFor(sess) { return [await modelOption(sess), modeOption(sess)]; }

// What a scripted harness reads instead of parsing the option list — including
// what the model can do: `toolFree` and the tools it is offered.
function sessionMeta(sess) {
  if (sess.kind === "completion") {
    const c = sess.completion;
    return { omniwork: { mode: COMPLETION.id, toolFree: true, tools: [], model: c.model, fallbackModels: c.fallbackModels, persisted: false } };
  }
  const tools = sess.agent.isEngine ? null : sess.agent.toolSchema().map((t) => t.function.name);
  return { omniwork: {
    mode: sess.mode, toolFree: false, tools, ...(sess.agent.isEngine ? { engine: "opencode" } : {}),
    model: sess.agent.model, fallbackModels: sess.agent.fallbackModels,
    capabilityPolicy: sess.deniedTools ? "strict" : "local",
    ...(sess.mcp ? { mcpServers: sess.mcp.list().map(({ name, status, error }) => ({ name, status, ...(error ? { error } : {}) })) } : {}),
  } };
}

async function setMode(sess, modeId) {
  if (!MODES.some((m) => m.id === modeId)) throw new RpcError(-32602, `unknown mode: ${modeId}`);
  if (sess.kind === "completion") {
    if (modeId !== COMPLETION.id) throw new RpcError(-32602, "a completion session stays tool-free for its lifetime — start a new session for agent work");
    return;
  }
  if (modeId === COMPLETION.id) toCompletion(sess);
  else {
    sess.mode = modeId;
    sess.agent.approvalMode = modeId;
    persist(sess);
  }
  notify("session/update", { sessionId: sess.id, update: { sessionUpdate: "current_mode_update", currentModeId: sess.mode } });
}

async function setModel(sess, modelId) {
  const id = String(modelId == null ? "" : modelId).trim();
  if (!id) throw new RpcError(-32602, "model id is required");
  if (sess.running) throw new RpcError(-32000, "cannot change the model while a prompt is running");
  if (sess.kind === "completion") {
    sess.completion = completionSettings({ model: id }, sess.completion);
    const configOptions = await configOptionsFor(sess);
    notify("session/update", { sessionId: sess.id, update: { sessionUpdate: "config_option_update", configOptions } });
    return configOptions;
  }
  if (!opencode.isEngineModel(id)) sess.gw = await ensureGateway(log);
  const catalog = opencode.isEngineModel(id) ? [] : await listModels(sess.gw).catch(() => []);
  if (!opencode.isEngineModel(id)) {
    const resolved = await resolveModelsLive(sess.gw, { model: id, fallbackModels: sess.agent.fallbackModels });
    sess.modelContexts = resolved.modelContexts || {};
    if (!sess.agent.isEngine) sess.agent.modelContexts = sess.modelContexts;
  }
  // Not an error: passthrough providers accept ids the catalog doesn't list.
  if (catalog.length && !catalog.includes(id)) log(`model ${id} is not in the gateway catalog — passing it through`);
  if (Boolean(sess.agent.isEngine) !== opencode.isEngineModel(id)) {
    attachAgent(sess, id, sess.agent.fallbackModels.filter((m) => m !== id), { messages: sess.agent.messages });
  } else {
    sess.agent.setModel(id);
    sess.agent.fallbackModels = sess.agent.fallbackModels.filter((m) => m !== id);
  }
  persist(sess);
  const configOptions = await configOptionsFor(sess);
  notify("session/update", { sessionId: sess.id, update: { sessionUpdate: "config_option_update", configOptions } });
  return configOptions;
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

        // The OpenCode engine streams the model's reasoning separately; ACP has
        // a native lane for it.
        case "reasoning_delta":
          if (p.chunk) up({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: p.chunk } });
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
          const failed = /^(Error in |Failed to |Unknown tool:|❌ Denied|⏸ Plan mode|Search failed|Browse failed|Install failed)/.test(out);
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
          } else if (p.kind === "tool" || p.kind === "text" || p.kind === "error" || p.kind === "model") {
            const t = tools.get("sub:" + p.subId);
            if (!t) break;
            const line = p.kind === "tool" ? `→ ${p.tool}`
              : p.kind === "error" ? `error: ${p.message}`
              : p.kind === "model" ? `⇄ ${p.from} failed — continuing on ${p.to}`
              : String(p.snippet || "");
            up({
              sessionUpdate: "tool_call_update", toolCallId: t.acpId, status: "in_progress",
              content: [{ type: "content", content: { type: "text", text: line + "\n" } }],
            });
          } else if (p.kind === "done") {
            const t = tools.get("sub:" + p.subId);
            if (t) up({ sessionUpdate: "tool_call_update", toolCallId: t.acpId, status: "completed" });
          } else if (p.kind === "tool_result" && p.payload) {
            // Closes the tool call opened when this subagent's tool asked permission.
            const t = tools.get(p.payload.id);
            if (t && t.sub) up({ sessionUpdate: "tool_call_update", toolCallId: t.acpId, status: p.payload.ok === false ? "failed" : "completed" });
          }
          break;
        }

        case "model_switch":
          configOptionsFor(sess)
            .then((configOptions) => up({ sessionUpdate: "config_option_update", configOptions }))
            .catch(() => {});
          break;

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

  // A permission answer applies to this call, or — "always" — to this tool
  // for the rest of the session (a command: that exact command). It never
  // changes the session's mode.
  sess.approve = async (callId, name, args = {}) => {
    const key = permissionKey(name, args);
    if (sess.rejected.has(key)) return false;
    if (sess.allowed.has(key)) return true;
    let t = tools.get(callId);
    if (!t || t.name !== name) {
      // A subagent's tool call: the client hasn't been told about it yet, and
      // a permission request must name a tool call it has seen.
      t = { acpId: `t${++toolSeq}`, name, args, sub: true };
      tools.set(callId, t);
      up({ sessionUpdate: "tool_call", toolCallId: t.acpId, title: `subagent: ${toolTitle(name, args)}`, kind: TOOL_KIND[name] || "other", status: "pending", rawInput: args });
    }
    const what = name === "run_command" ? "this command" : name;
    const asked = callClient("session/request_permission", {
      sessionId: sid,
      toolCall: {
        toolCallId: t.acpId,
        title: toolTitle(name, args),
        kind: TOOL_KIND[name] || "other",
        status: "pending",
        rawInput: args,
        ...(t.diff ? { content: t.diff } : {}),
      },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "allow_always", name: `Always allow ${what} in this session`, kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        { optionId: "reject_always", name: `Never allow ${what} in this session`, kind: "reject_always" },
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
    const verdict = (ok) => {
      if (t.sub) up({ sessionUpdate: "tool_call_update", toolCallId: t.acpId, status: ok ? "in_progress" : "failed" });
      return ok;
    };
    if (!res) return verdict(false);
    const outcome = res.outcome;
    // `cancelled` means the client is cancelling the turn: don't run the tool,
    // and stop.
    if (!outcome || outcome.outcome === "cancelled") { try { sess.agent.abort(); } catch {} return verdict(false); }
    if (outcome.outcome !== "selected") return verdict(false);
    switch (outcome.optionId) {
      case "allow_always": sess.allowed.add(key); return verdict(true);
      case "allow_once": return verdict(true);
      case "reject_always": sess.rejected.add(key); return verdict(false);
      default: return verdict(false);
    }
  };

  try {
    await sess.agent.send(text, images);
    // No gateway model answered, but OpenCode is installed: finish the turn on
    // its engine and keep the session there. The client sees the switch as a
    // message and a config_option_update, same as any other model change.
    if (failure && isNoModelFailure(failure) && !sess.agent.isEngine && !sess.agent.aborted) {
      const model = await engineFallbackModel();
      if (model) {
        const prevFailure = failure;
        failure = null;
        attachAgent(sess, model, [], { messages: sess.agent.messages });
        up({ sessionUpdate: "agent_message_chunk", messageId: `sys${Date.now().toString(36)}`, content: { type: "text", text: `⇄ no gateway model answered (${prevFailure.split("\n")[0].slice(0, 120)}) — continuing on the OpenCode engine (${model})\n` } });
        configOptionsFor(sess).then((configOptions) => up({ sessionUpdate: "config_option_update", configOptions })).catch(() => {});
        await sess.agent.send(text, images);
      }
    }
  } finally {
    sess.sink = () => {};
    sess.approve = async () => false;
    persist(sess);
  }

  if (failure) {
    const noModel = isNoModelFailure(failure);
    const message = noModel || /Gateway 429/.test(failure) ? `${failure}\n\n${noModelHint()}` : failure;
    // OMNIWORK_ACP_ERRORS=rpc keeps the old JSON-RPC error for one release.
    if (/^rpc$/i.test(process.env.OMNIWORK_ACP_ERRORS || "")) throw new RpcError(-32000, message);
    // A model failure is not a protocol failure: say it in the transcript and
    // end the turn, with the details where a client can read them.
    up({ sessionUpdate: "agent_message_chunk", messageId: `err${Date.now().toString(36)}`, content: { type: "text", text: `\n⚠ ${message}\n` } });
    return { stopReason: "end_turn", _meta: { omniwork: { error: { message: failure, noModel } } } };
  }
  return { stopReason };
}

// ── method handlers ───────────────────────────────────────────────
const handlers = {
  async initialize(params) {
    clientCapabilities = (params && params.clientCapabilities && typeof params.clientCapabilities === "object") ? params.clientCapabilities : {};
    // Overlap the OmniRoute boot with the client's setup — unless this server
    // only does tool-free completion, which may never need the gateway.
    if (DEFAULT_MODE !== COMPLETION.id) prewarmGateway(log);
    const wanted = Number(params && params.protocolVersion);
    return {
      protocolVersion: Number.isFinite(wanted) && wanted < PROTOCOL_VERSION ? wanted : PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        // OmniWork's tools do their own filesystem and process work, so we never
        // call back into the client's fs/* or terminal/*.
        mcpCapabilities: { http: false, sse: false },
        // Tool-free completion: `_meta.omniwork.mode: "completion"` on session/new.
        _meta: { omniwork: { completionMode: true } },
      },
      agentInfo: { name: "omniwork", title: "OmniWork", version: VERSION },
      // Not required — OmniWork reaches its own gateway itself — but the way an
      // ACP client can give OmniWork a free provider that actually stays up.
      authMethods: AUTH_METHODS,
    };
  },

  // Sessions never *require* auth; `authenticate` is how a client connects a
  // free provider. `openrouter` opens the user's browser for a one-click key
  // (PKCE); `local` registers model servers running on this machine.
  async authenticate(params) {
    const methodId = params && params.methodId;
    if (!methodId) return {};
    if (!AUTH_METHODS.some((m) => m.id === methodId)) throw new RpcError(-32602, `unknown auth method: ${methodId}`);
    const gw = await ensureGateway(log);
    const result = await providers.connect(gw, methodId, { install: true, onUrl: (url) => log("open this URL to connect OpenRouter:", url) });
    invalidateModels();
    const chain = providers.suggestChain(await listModels(gw));
    // Agent sessions only: completion never falls back to a model it wasn't given.
    for (const sess of sessions.values()) if (sess.agent) sess.agent.fallbackModels = chain.filter((m) => m !== sess.agent.model);
    log("connected", methodId, JSON.stringify(result).slice(0, 200));
    return {};
  },

  async "session/new"(params) {
    const cwd = checkCwd(params && params.cwd);
    const id = `sess_${Date.now().toString(36)}_${++sessionSeq}`;
    const meta = (params && params._meta) || {};
    const ow = (meta.omniwork && typeof meta.omniwork === "object") ? meta.omniwork : {};
    const mode = ow.mode ?? meta.mode ?? DEFAULT_MODE;
    if (!MODES.some((m) => m.id === mode)) throw new RpcError(-32602, `unknown mode: ${mode}`);
    if (mode === COMPLETION.id) {
      if (Array.isArray(params.mcpServers) && params.mcpServers.length) throw new RpcError(-32602, "a completion session offers no tools, so it takes no MCP servers");
      const sess = newCompletionSession(id, cwd, completionSettings({ ...ow, model: ow.model ?? meta.model, fallbackModels: ow.fallbackModels ?? ow.fallback_models ?? meta.fallbackModels ?? meta.fallback_models }));
      return { sessionId: id, modes: modesFor(sess), configOptions: await configOptionsFor(sess), _meta: sessionMeta(sess) };
    }
    const strict = ow.honorClientCapabilities === true || /^(1|true|yes|on)$/i.test(process.env.OMNIWORK_ACP_STRICT_CAPABILITIES || "");
    const sess = await buildSession({
      id, cwd, mode,
      model: ow.model ?? meta.model, fallbackModels: ow.fallbackModels ?? meta.fallbackModels ?? meta.fallback_models,
      mcp: sessionMcp(params.mcpServers), deniedTools: deniedByCapabilities(strict),
      projectFiles: typeof ow.projectFiles === "boolean" ? ow.projectFiles : undefined,
    });
    persist(sess);
    setTimeout(() => pushCommands(sess), 0); // after we've returned the sessionId
    return {
      sessionId: id,
      modes: modesFor(sess),
      configOptions: await configOptionsFor(sess),
      _meta: sessionMeta(sess),
    };
  },

  async "session/load"(params) {
    const id = params && params.sessionId;
    if (!id) throw new RpcError(-32602, "sessionId is required");
    const file = sessionFile(id);
    const cwd = params && params.cwd != null ? checkCwd(params.cwd) : null;
    let sess = sessions.get(id);
    if (!sess) {
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (!saved) throw new RpcError(-32602, `unknown session: ${id}`);
      sess = await buildSession({
        id, cwd: cwd || checkCwd(saved.cwd), mode: saved.mode, messages: saved.messages,
        model: saved.model, fallbackModels: saved.fallbackModels, engineSession: saved.engineSession,
        mcp: sessionMcp(params.mcpServers),
      });
    }
    // ACP requires the whole conversation to be replayed as updates *before* we
    // answer the request. (A completion session keeps none.)
    for (const m of sess.agent ? sess.agent.messages : []) {
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
    return {
      modes: modesFor(sess),
      configOptions: await configOptionsFor(sess),
      _meta: sessionMeta(sess),
    };
  },

  async "session/prompt"(params) {
    const sess = sessions.get(params && params.sessionId);
    if (!sess) throw new RpcError(-32602, `unknown session: ${params && params.sessionId}`);
    if (sess.running) throw new RpcError(-32000, "a prompt is already running in this session");
    sess.running = true;
    try { return sess.kind === "completion" ? await runCompletion(sess, params) : await runTurn(sess, params.prompt); }
    finally { sess.running = false; }
  },

  async "session/set_mode"(params) {
    const sess = sessions.get(params && params.sessionId);
    if (!sess) throw new RpcError(-32602, `unknown session: ${params && params.sessionId}`);
    await setMode(sess, params && params.modeId);
    return {};
  },

  async "session/set_config_option"(params) {
    const sess = sessions.get(params && params.sessionId);
    if (!sess) throw new RpcError(-32602, `unknown session: ${params && params.sessionId}`);
    const configId = params && params.configId;
    if (configId === "model") return { configOptions: await setModel(sess, params.value) };
    if (configId === "mode") {
      await setMode(sess, params.value);
      const configOptions = await configOptionsFor(sess);
      notify("session/update", { sessionId: sess.id, update: { sessionUpdate: "config_option_update", configOptions } });
      return { configOptions };
    }
    throw new RpcError(-32602, `unknown config option: ${configId}`);
  },

  // The pre-config-option way to pick a model; some clients still speak it.
  async "session/set_model"(params) {
    const sess = sessions.get(params && params.sessionId);
    if (!sess) throw new RpcError(-32602, `unknown session: ${params && params.sessionId}`);
    await setModel(sess, params && params.modelId);
    return {};
  },
};

const notifications = {
  "session/cancel"(params) {
    const sess = sessions.get(params && params.sessionId);
    if (!sess) return;
    if (sess.kind === "completion") { sess.abort?.abort(); return; }
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
process.on("exit", () => { for (const sess of sessions.values()) { try { sess.mcp?.stopAll(); } catch {} } });
log(`OmniWork ACP agent ready (stdio, protocol v${PROTOCOL_VERSION}, mode ${DEFAULT_MODE})`);
