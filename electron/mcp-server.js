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
const { agentEnv, browser, ensureGateway, prewarmGateway, resolveModelsLive, listModels, invalidateModels, noModelHint, providers, makeAgent, isNoModelFailure, engineFallbackModel, opencode, SKILLS_DIR } = require("./headless");
const skillsApi = require("./skills");
const tuning = require("./tuning");

ensureShellPath(); // MCP clients can launch us with a minimal environment too

const log = (...a) => process.stderr.write("[omniwork-mcp] " + a.join(" ") + "\n");

// A backstop, not a work budget: a free model that stalls mid-turn used to hang
// the caller until *its* client timeout, with nothing to show for it. On expiry
// we abort the agent and return whatever it managed to finish.
const DELEGATE_TIMEOUT_MS = Number(process.env.OMNIWORK_DELEGATE_TIMEOUT_MS || 600_000);

// Run one delegated task; capture a change log + final summary.
async function runDelegate({ task, cwd, model, fallbackModels, progress }) {
  const gw = await ensureGateway(log);
  const workspace = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const changes = [];
  let steps = 0;
  let failure = null;
  const emit = (type, p) => {
    if (type === "thinking") progress(++steps, "thinking…");
    else if (type === "error") failure = String(p.message || "");
    else if (type === "tool_call") {
      const a = p.args || {};
      const file = a.path || a.filePath || a.file;
      if (/^(write_file|write)$/.test(p.name)) changes.push(`wrote ${file}`);
      else if (/^(edit_file|edit|patch)$/.test(p.name)) changes.push(`edited ${file}`);
      else if (/^(run_command|bash)$/.test(p.name)) changes.push(`ran: ${String(a.command).slice(0, 80)}`);
      progress(steps, `${p.name} ${String(file || a.command || a.query || a.pattern || "").slice(0, 60)}`.trim());
    }
  };
  const build = (models) => makeAgent({
    baseUrl: gw.baseUrl, apiKey: gw.apiKey, ...models,
    workspace, canSpawn: true, ...agentEnv(workspace),
    // The caller sees a single tool result, never the token stream.
    streaming: false,
    emit,
  });
  let agent = build(await resolveModelsLive(gw, { model, fallbackModels }));

  let timedOut = false;
  let engineNote = "";
  const timer = setTimeout(() => { timedOut = true; agent.abort(); }, DELEGATE_TIMEOUT_MS);
  try {
    await agent.send(task);
    // No gateway model answered, but OpenCode is installed: run the same task on
    // its engine instead of returning a dead delegation.
    if (failure && !agent.lastText && isNoModelFailure(failure) && !agent.isEngine && !timedOut) {
      const engineModel = await engineFallbackModel();
      if (engineModel) {
        engineNote = `\n\n[model: no gateway model answered (${failure.split("\n")[0].slice(0, 100)}) — ran on the OpenCode engine, ${engineModel}]`;
        failure = null;
        agent = build({ model: engineModel, fallbackModels: [] });
        await agent.send(task);
      }
    }
  } finally { clearTimeout(timer); }
  // A turn that produced nothing but an error is an error, not "(no summary)".
  // When the error is "no model answered" it comes with the way out.
  if (failure && !agent.lastText) {
    throw new Error(isNoModelFailure(failure) ? `${failure}\n\n${noModelHint()}` : failure);
  }

  const summary = agent.lastText || "(no summary)";
  const changeLog = changes.length ? `\n\nChanges:\n- ${changes.join("\n- ")}` : "";
  const note = timedOut ? `\n\n[stopped after ${Math.round(DELEGATE_TIMEOUT_MS / 1000)}s — this is partial work]` : "";
  // A cheap PASS/FAIL gate on the utility model, so the orchestrator re-delegates
  // only when the work actually fell short — the expensive path is the caller
  // re-reading and re-issuing, and this cuts it when the task already succeeded.
  const verifyNote = (timedOut || !tuning.shouldVerify(task, changes.length > 0)) ? "" : await verifyDelegate(agent, task, summary, changeLog).catch(() => "");
  return `${summary}${changeLog}${modelNote(agent)}${engineNote}${verifyNote}${note}`;
}

async function verifyDelegate(agent, task, summary, changeLog) {
  if (!agent || typeof agent.oneShot !== "function" || !summary || summary === "(no summary)") return "";
  const prompt =
    "You are grading whether a coding agent completed a task. Reply with exactly PASS or FAIL, then a dash and one short reason.\n\n" +
    `TASK:\n${String(task).slice(0, 1500)}\n\nAGENT SUMMARY:\n${String(summary).slice(0, 1500)}${changeLog.slice(0, 600)}`;
  let out = "";
  try { out = String(await agent.oneShot(prompt)).trim(); } catch { return ""; }
  const m = /^(PASS|FAIL)\b[\s-]*(.*)$/i.exec(out.split("\n")[0] || "");
  if (!m) return "";
  const verdict = m[1].toUpperCase();
  return `\n\n[verify: ${verdict}${m[2] ? " — " + m[2].slice(0, 140) : ""}]`;
}

// The caller asked for a model; if it got a different one, it should know.
function modelNote(agent) {
  if (!agent.modelSwitches.length) return "";
  const hops = agent.modelSwitches.map((s) => `${s.from} failed (${s.reason.slice(0, 120)})`).join("; ");
  return `\n\n[model: ran on ${agent.model} — ${hops}]`;
}

// The catalog, grouped by provider prefix so a long list reads at a glance.
async function listModelsText() {
  const ids = await listModels(await ensureGateway(log));
  if (!ids.length) return "The gateway returned no models (is it still starting? retry in a few seconds).";
  const groups = new Map();
  for (const id of ids) {
    const i = id.indexOf("/");
    const p = i > 0 ? id.slice(0, i) : "(other)";
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(id);
  }
  const lines = [`${ids.length} models. \`auto\` routes the free pool; a provider prefix pins one. Models behind a provider key you haven't added will fail — put them in fallback_models after a free one, or use them alone only if the key is configured in the router dashboard.`, ""];
  for (const [p, list] of groups) lines.push(`## ${p} (${list.length})`, list.join(", "), "");
  if (opencode.available()) {
    let engine = [];
    try { engine = await opencode.getEngine().models(); } catch (e) { lines.push(`## opencode (engine)`, `could not list: ${e.message}`, ""); }
    if (engine.length) lines.push(`## opencode (engine — free, no account; runs on OpenCode's own server and tools)`, engine.map((m) => m.id).join(", "), "");
  } else {
    lines.push(`## opencode (engine) — not present yet`, `${opencode.INSTALL_COMMAND} (a ~45 MB download the user runs) adds its free Zen models (Nemotron 3.5 Lightning, MiMo V2.5, Big Pickle, Ling 3.0 Flash, Nemotron 3 Ultra) as an engine that needs no account.`, "");
  }
  return lines.join("\n").trim();
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
      },
      required: ["task"],
    },
  },
  {
    name: "delegate_parallel",
    description:
      "Delegate MANY independent subtasks at once; OmniWork fans them out to parallel subagents (free models by default, or the model you pick) and returns all summaries. USE instead of N sequential delegate calls whenever tasks don't depend on each other (write N files, refactor N modules, research N topics). Each task must be fully self-contained.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "string" }, description: "Independent, self-contained subtask instructions." },
        cwd: { type: "string", description: "Absolute working directory. Always pass this explicitly." },
        model: MODEL_PARAM,
        fallback_models: FALLBACK_PARAM,
      },
      required: ["tasks"],
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
    description:
      "List the model ids OmniWork's gateway can route right now, grouped by provider. USE before pinning a model in delegate/delegate_parallel, or when a pinned model failed — free catalogs change as providers retire models.",
    inputSchema: { type: "object", properties: {}, required: [] },
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
  if (name === "delegate") return await runDelegate({ task: args.task, cwd: args.cwd, model: args.model, fallbackModels: args.fallback_models, progress });
  if (name === "list_models") return await listModelsText();
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
    const gw = await ensureGateway(log);
    const workspace = args.cwd && fs.existsSync(args.cwd) ? args.cwd : process.cwd();
    let done = 0;
    const tasks = (args.tasks || []).map((t, i) => ({ title: `task ${i + 1}`, prompt: t }));
    const switched = [];
    const agent = makeAgent({
      baseUrl: gw.baseUrl, apiKey: gw.apiKey, ...(await resolveModelsLive(gw, { model: args.model, fallbackModels: args.fallback_models })),
      workspace, canSpawn: true, ...agentEnv(workspace), streaming: false,
      emit: (type, p) => {
        if (type !== "subagent") return;
        if (p.kind === "done") progress(++done, `${done}/${tasks.length} subagents finished`, tasks.length);
        else if (p.kind === "tool") progress(done, `${p.title || "subagent"}: ${p.tool}`, tasks.length);
        else if (p.kind === "model") { switched.push(`${p.from} → ${p.to}`); progress(done, `${p.title || "subagent"}: model ${p.from} failed, continuing on ${p.to}`, tasks.length); }
      },
    });
    if (agent.isEngine) {
      // The engine has no in-loop subagents; each task gets its own session.
      const results = await Promise.all(tasks.map(async (t) => {
        const one = makeAgent({
          baseUrl: gw.baseUrl, apiKey: gw.apiKey, model: agent.model, fallbackModels: [],
          workspace, canSpawn: false, ...agentEnv(workspace), streaming: false,
          emit: (type, p) => { if (type === "tool_call") progress(done, `${t.title}: ${p.name}`, tasks.length); },
        });
        await one.send(t.prompt);
        progress(++done, `${done}/${tasks.length} engine sessions finished`, tasks.length);
        return `## ${t.title}\n${one.lastText || "(no summary returned)"}`;
      }));
      return results.join("\n\n---\n\n");
    }
    const out = await agent.runSubagents(tasks);
    return switched.length ? `${out}\n\n[model: some subagents fell back — ${[...new Set(switched)].join(", ")}]` : out;
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
