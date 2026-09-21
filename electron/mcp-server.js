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
const { agentEnv, browser, ensureGateway, prewarmGateway, resolveModelsLive, invalidateModels, providers, makeAgent, isNoModelFailure, engineFallbackModel, opencode, SKILLS_DIR } = require("./headless");
const skillsApi = require("./skills");
const { executeTask, mapLimit, formatResult } = require("./execution");
const { executeToolResult } = require("./tools");
const modelCatalog = require("./model-catalog");
const { resolveModels } = require("./headless");
const jobTools = require("./job-tools");

ensureShellPath(); // MCP clients can launch us with a minimal environment too

const log = (...a) => process.stderr.write("[omniwork-mcp] " + a.join(" ") + "\n");

// A backstop, not a work budget: a free model that stalls mid-turn used to hang
// the caller until *its* client timeout, with nothing to show for it. On expiry
// we abort the agent and return whatever it managed to finish.
const DELEGATE_TIMEOUT_MS = Number(process.env.OMNIWORK_DELEGATE_TIMEOUT_MS || 600_000);

// The same contract and deadline for one task or every item in a batch.
async function runDelegate({ task, cwd, model, fallbackModels, checks = [], progress = () => {}, signal }) {
  if (!task || typeof task !== "string") throw new Error("task must be a non-empty string");
  if (!cwd || !require("node:path").isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("cwd must be an existing absolute directory");
  if (!Array.isArray(checks) || checks.some(c => typeof c !== "string" || !c.trim()) || checks.length > 10) throw new Error("checks must contain up to 10 shell commands");
  const workspace = cwd;
  let gw;
  const build = (models, emit) => makeAgent({ baseUrl: gw?.baseUrl || "http://127.0.0.1", apiKey: gw?.apiKey, ...models, workspace, canSpawn: true, ...agentEnv(workspace), streaming: false, emit });
  return executeTask({ task, checks, signal, timeoutMs: DELEGATE_TIMEOUT_MS, progress,
    createAgent: async (emit, signal) => {
      const selected = resolveModels({ model, fallbackModels });
      // Explicit engine choices must work even when OmniRoute cannot boot.
      if (opencode.isEngineModel(selected.model)) return build(selected, emit);
      gw = await ensureGateway(log);
      if (signal.aborted) throw new Error("Cancelled before execution");
      return build(await resolveModelsLive(gw, { model, fallbackModels }), emit);
    },
    recover: async (failure, previous, emit, signal) => {
      if (previous.isEngine || !isNoModelFailure(failure) || signal.aborted) return null;
      const engineModel = await engineFallbackModel();
      return engineModel && !signal.aborted ? build({ model: engineModel, fallbackModels: [] }, emit) : null;
    },
    runCheck: (command, signal) => executeToolResult("run_command", { command }, { workspace, signal }),
  });
}

async function listModelsText(options = {}) {
  const gw = await ensureGateway(log).catch(() => null);
  const result = await modelCatalog.catalog(gw, { force: Boolean(options.refresh) });
  const all = modelCatalog.filterModels(result.models, options);
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit) || 40)));
  const rows = all.slice(offset, offset + limit);
  return `${all.length} matching models; showing ${offset + 1}-${offset + rows.length}. Catalog availability is untested. Paid models require explicit selection.\n`
    + rows.map(m => `${m.id} | ${m.pricing} | tools: ${m.tools == null ? "unknown" : m.tools ? "yes" : "no"} | context: ${m.context || "unknown"} | ${m.access}`).join("\n")
    + (offset + rows.length < all.length ? `\nMore: list_models(offset=${offset + rows.length})` : "")
    + result.errors.map(e => `\n${e.source}: ${e.message}`).join("")
    + `\nConnect additional providers using OpenCode's own auth login, or OmniWork's provider panel. Refresh after connecting.`;
}

const MODEL_PARAM = {
  type: "string",
  description: "Model id to run on (see list_models). Default: OMNIWORK_MODEL, else 'auto' (the free pool).",
};
const FALLBACK_PARAM = {
  type: "array", items: { type: "string" },
  description: "Tried in order if the model fails (retired id, no provider key, quota). Default: OMNIWORK_MODEL_FALLBACKS. End with a paid model you have a key for when the task must complete.",
};

const TOOLS = [
  ...jobTools.TOOLS,
  {
    name: "delegate",
    description:
      "Delegate ONE coding/research subtask to OmniWork, which executes it autonomously (reads/writes/edits files, runs commands, browses the web) — on free models by default, or on the model you pick — in the given working directory and returns a summary + change list. The agent has OmniWork's installed skills and remembers facts saved to its memory across delegations. USE for: mechanical/boilerplate work, scaffolding, repetitive edits, read-heavy research, anything cheap to verify. DON'T use for: tasks needing the current conversation's context (delegates start cold — write fully self-contained instructions), tiny tasks (~30s overhead), precision-critical specs, or destructive/hard-to-undo changes. Always pass cwd. Verify the result yourself — the summary is a claim, not evidence.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Full, self-contained instruction. Include every fact the agent needs — it cannot see your conversation." },
        cwd: { type: "string", description: "Absolute working directory. Always pass this explicitly." },
        model: MODEL_PARAM,
        fallback_models: FALLBACK_PARAM,
        checks: { type: "array", maxItems: 10, items: { type: "string" }, description: "Acceptance commands to run after completion, e.g. npm test. Results include exit codes. Without checks the result is unverified." },
      },
      required: ["task", "cwd"],
    },
  },
  {
    name: "delegate_parallel",
    description:
      "Delegate MANY independent subtasks at once; OmniWork fans them out to parallel subagents (free models by default, or the model you pick) and returns all summaries. USE instead of N sequential delegate calls whenever tasks don't depend on each other (write N files, refactor N modules, research N topics). Each task must be fully self-contained.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" }, description: "Independent, self-contained subtask instructions." },
        cwd: { type: "string", description: "Absolute working directory. Always pass this explicitly." },
        model: MODEL_PARAM,
        fallback_models: FALLBACK_PARAM,
        checks: { type: "array", maxItems: 10, items: { type: "string" }, description: "Acceptance commands to run after completion, e.g. npm test. Results include exit codes. Without checks the result is unverified." },
      },
      required: ["tasks", "cwd"],
    },
  },
  {
    name: "list_providers",
    description:
      "Show which free model providers are connected to OmniWork's gateway, the fallback chain delegations will use, local model servers detected on this machine, and how to connect more. USE when a delegation reports 'All models failed' or before relying on OmniWork for unattended work — the built-in keyless pool is unreliable, a connected provider is not.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "connect_provider",
    description:
      "Connect a free model provider to OmniWork's gateway so delegations always have a model. provider='openrouter' OPENS THE USER'S BROWSER for a one-click sign-in (PKCE; the user completes it, no key passes through here) — tell the user before calling. provider='local' registers any Ollama / LM Studio / llama.cpp / vLLM server running on this machine. provider='opencode' reports the OpenCode engine. Key-based providers (ollama-cloud, kilo-gateway, groq, cerebras, nvidia, gemini, mistral) cannot be connected from this tool: this tool takes no API key, on purpose — a key pasted by a model would route the user's code through whoever supplied it. Tell the user to paste it in the OmniWork app's free-models panel or run 'npm run providers connect <provider> <key>'.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "openrouter | local | opencode" },
      },
      required: ["provider"],
    },
  },
  {
    name: "list_models",
    description: "Search available gateway and connected OpenCode model catalogs, with pricing class, tool support and context size. Catalog entries are untested. Use filters before pinning a model. Refresh after connecting a provider.",
    inputSchema: { type: "object", properties: {
      query: { type: "string" }, free_only: { type: "boolean" }, tools_only: { type: "boolean" },
      refresh: { type: "boolean" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 },
    } },
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

async function callTool(name, args, progress = () => {}, signal) {
  if (jobTools.TOOLS.some(t => t.name === name)) return jobTools.call(name, args, signal);
  if (name === "delegate") return await runDelegate({ task: args.task, cwd: args.cwd, model: args.model, fallbackModels: args.fallback_models, checks: args.checks, progress, signal });
  if (name === "list_models") return await listModelsText(args);
  if (name === "list_providers") return providers.describe(await providers.status(await ensureGateway(log)));
  if (name === "connect_provider") {
    const gw = await ensureGateway(log);
    if (args.provider === "opencode") {
      if (opencode.available()) {
        const list = await opencode.getEngine().models().catch(() => []);
        return `OpenCode is installed (${opencode.version() || "?"}). Engine models: ${list.map((m) => m.id).join(", ") || "(none listed yet)"}. Pass one as \`model\` to delegate, or rely on the automatic fallback.`;
      }
      return `OpenCode is not present yet. It is a ~45 MB download, so it needs the user's own gesture (not a tool call): ${opencode.INSTALL_COMMAND} in the omniwork checkout, or the Download button in the app's free-models panel. Afterwards its free Zen models appear as opencode/… in list_models and become the automatic fallback.`;
    }
    if (!["openrouter", "local"].includes(args.provider)) {
      const p = providers.CATALOG.find((c) => c.id === args.provider);
      return p
        ? `${p.name} needs an API key, and this tool takes none — a key supplied by a model would route the user's code through whoever supplied it. Ask the user to create one at ${p.keyUrl} and paste it in the OmniWork app's free-models panel, or run: npm run providers connect ${p.id} <key>`
        : `unknown provider: ${args.provider} (this tool connects openrouter, local, or opencode)`;
    }
    let url = null;
    const result = await providers.connect(gw, args.provider, {
      onUrl: (u) => { url = u; progress(0, "waiting for the OpenRouter sign-in in the browser…"); },
    });
    invalidateModels();
    const st = await providers.status(gw, { detectLocal: false });
    const head = result.added
      ? (result.added.length
        ? `Registered local: ${result.added.map((a) => `${a.name} (${a.models.length} models)`).join(", ")}.`
        : `No local model server is running (${result.skipped.map((s) => s.name).join(", ")} checked).`)
      : `Connected ${result.name} — ${result.models} models now routable.`;
    return `${head}${url ? `\n(sign-in URL was ${url})` : ""}\nFallback chain now: ${st.chain.length ? st.chain.join(" → ") : "(empty)"}`;
  }
  if (name === "delegate_parallel") {
    if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 100 || args.tasks.some(t => typeof t !== "string" || !t.trim())) throw new Error("tasks must contain 1–100 non-empty task strings");
    const results = await mapLimit(args.tasks, 4, (task, i) => runDelegate({ task, cwd: args.cwd, model: args.model, fallbackModels: args.fallback_models, checks: args.checks, signal, progress: (step, text) => progress(step, `Task ${i + 1}: ${text}`) }));
    return { status: results.every(r => r.status === "completed") ? "completed" : "partial", tasks: results };
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

const activeRequests = new Map();
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "notifications/cancelled") { activeRequests.get(params?.requestId)?.abort(); return; }
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
    const controller = new AbortController(); activeRequests.set(id, controller);
    try {
      const result = await callTool(params.name, params.arguments || {}, progress, controller.signal);
      if (jobTools.TOOLS.some(t => t.name === params.name)) reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      else if (typeof result === "string") reply(id, { content: [{ type: "text", text: result }] });
      else {
        const text = result.tasks ? result.tasks.map((r,i) => `## task ${i + 1}\n${formatResult(r)}`).join("\n\n") : formatResult(result);
        reply(id, { content: [{ type: "text", text }], structuredContent: result, isError: result.status !== "completed" });
      }
    } catch (e) {
      reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    } finally { activeRequests.delete(id); }
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
process.stdin.on("end", () => { for (const ctl of activeRequests.values()) ctl.abort(); setTimeout(() => process.exit(0), 600).unref(); });
log("OmniWork MCP server ready (stdio)");
