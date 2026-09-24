"use strict";
// The OpenCode engine, against test/fixtures/fake-opencode.js standing in for
// `opencode serve`: model discovery (free only), the event → OmniWork-event
// mapping (deltas, tools, permissions, errors, abort), and the two headless
// servers falling through to the engine when the gateway has no model.
//
// Run: node test/opencode.js
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const FAKE = path.join(__dirname, "fixtures", "fake-opencode.js");
process.env.OMNIWORK_OPENCODE_BIN = FAKE;
const opencode = require("../electron/opencode-engine");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-oc-"));

// A gateway that lists models but can't serve any of them: the failure this
// engine exists for.
function deadPoolGateway() {
  const server = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith("/v1/models")) return json(200, { data: [{ id: "auto" }, { id: "oc/retired-free" }] });
    if (req.url.startsWith("/api/providers")) return json(200, { connections: [] });
    let s = ""; req.on("data", (d) => { s += d; }); req.on("end", () => json(503, { error: { message: "Maximum combo retry limit reached", type: "server_error" } }));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() })));
}

function rpcClient(file, env) {
  const proc = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"], env });
  const pending = new Map(); const notes = []; let id = 0; let buf = "";
  proc.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && m.method === undefined) { pending.get(m.id)?.(m); pending.delete(m.id); } else if (m.method) notes.push(m); } });
  const rpc = (method, params, ms = 60_000) => new Promise((res, rej) => { const i = ++id; pending.set(i, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(method + " timed out")); } }, ms); });
  return { proc, rpc, notes, updates: (t) => notes.filter((n) => n.method === "session/update" && n.params.update.sessionUpdate === t) };
}

(async () => {
  // ── engine + agent, in-process ──
  const engine = opencode.getEngine();
  check("the binary is found via OMNIWORK_OPENCODE_BIN", opencode.available() && opencode.findBinary() === FAKE);
  const health = await engine.health();
  check("serve starts and reports health", health && health.healthy === true);
  const models = await engine.models();
  check("free models remain first with connected paid models available", models.filter(m => m.free).map((m) => m.id).join(",") === "opencode/nemotron-3.5-lightning-free,opencode/big-pickle,opencode/nemotron-3-ultra-free,opencode/ox-alpha-free");
  check("connected account models are exposed without leaking disconnected catalogs", models.some(m => m.id === "opencode/openai/connected-coder" && !m.free) && !models.some(m => m.providerID === "not-connected"));
  check("opencode-go models keep their provider", models.find((m) => m.modelID === "ox-alpha-free").providerID === "opencode-go");

  const run = async (text, { approvalMode = "auto", approver = null, model, engineProfile } = {}) => {
    const events = [];
    const agent = new opencode.OpenCodeAgent({ model, workspace, approvalMode, approver, engineProfile, emit: (type, p) => events.push({ type, ...p }) });
    await agent.send(text);
    return { agent, events };
  };
  const plain = await run("say READY");
  check("a plain turn answers on the default free model, scoped to the workspace", plain.agent.lastText === `READY from opencode/nemotron-3.5-lightning-free in ${workspace}`);
  check("…streaming text deltas and ending with done", plain.events.filter((e) => e.type === "assistant_delta").map((e) => e.chunk).join("") === plain.agent.lastText && plain.events.some((e) => e.type === "done"));
  check("reasoning streams on its own lane, never as reply text", plain.events.some((e) => e.type === "reasoning_delta" && /thinking/.test(e.chunk)) && !plain.events.some((e) => e.type === "assistant_delta" && /thinking/.test(e.chunk)));
  check("…and records the exchange in messages", plain.agent.messages.filter((m) => m.role === "assistant").length === 1);

  const tool = await run("TOOL then say READY");
  const call = tool.events.find((e) => e.type === "tool_call"); const result = tool.events.find((e) => e.type === "tool_result");
  check("tool parts map to tool_call / tool_result, announced once the input exists", call && call.name === "bash" && call.args.command === "echo hi" && result && result.id === call.id && result.result === "hi\n" && tool.events.filter((e) => e.type === "tool_call").length === 1);
  const usage = tool.events.find(e => e.type === "done");
  check("engine usage includes intermediate steps and cached tokens without double counting", usage.inTokens === 170 && usage.outTokens === 17 && usage.estimated === false);

  check("engine usage separates uncached input, cache reads, reasoning and request count", usage.uncachedInTokens === 150 && usage.cacheReadTokens === 20 && usage.cacheWriteTokens === 0 && usage.reasoningTokens === 2 && usage.modelRequests === 2);
  check("engine exposes per-message usage and tool correlation", tool.events.some(e => e.type === "request" && e.tokens?.input === 100) && call.requestId && result.outputBytes === 3);
  const { executeTask } = require("../electron/execution");
  let checkpointAgent, checksAtIdle = 0;
  const checkpointResult = await executeTask({ task: "TOOL SLOW", checks: ["fixture"], maxTokens: 1000, timeoutMs: 5000, verificationReserveTokens: 900, trace: true,
    createAgent: async emit => (checkpointAgent = new opencode.OpenCodeAgent({ engine, workspace, engineProfile: "scoped", emit })),
    runCheck: async () => { if (await engine.isIdle(checkpointAgent.sessionID, workspace)) checksAtIdle++; return { ok: true, exitCode: 0, text: "verified" }; },
  });
  check("engine checkpoint waits for abort acknowledgement and idle before checking", checkpointResult.status === "completed" && checkpointResult.completion?.checkpoint.confirmed && checksAtIdle === 1);
  check("engine checkpoint retains request/tool trace", checkpointResult.trace.requests.length >= 1 && checkpointResult.trace.tools.length === 1);
  const timedCheckpoint = await executeTask({ task: "SLOW", checks: ["fixture"], timeoutMs: 1500, verificationReserveMs: 1200,
    createAgent: async emit => new opencode.OpenCodeAgent({ engine, workspace, engineProfile: "scoped", emit }),
    runCheck: async () => ({ ok: true, exitCode: 0, text: "verified" }),
  });
  check("time reserve interrupts inference within the original deadline", timedCheckpoint.status === "completed" && timedCheckpoint.completion?.checkpoint.trigger === "time" && timedCheckpoint.elapsedMs < 1500);
  let prematureChecks = 0;
  const stillBusy = await executeTask({ task: "TOOL SLOW BUSY_AFTER_ABORT", checks: ["fixture"], maxTokens: 1000, timeoutMs: 5000, verificationReserveTokens: 900,
    createAgent: async emit => new opencode.OpenCodeAgent({ engine, workspace, engineProfile: "scoped", emit }),
    runCheck: async () => { prematureChecks++; return { ok: true, exitCode: 0, text: "must not run" }; },
  });
  check("an abort acknowledgement alone cannot authorize verification while status is busy", stillBusy.status !== "completed" && prematureChecks === 0 && /not be confirmed/.test(stillBusy.reason));
  const prompt = engine.prompt.bind(engine); let selectedAgent;
  engine.prompt = (sid, opts) => { selectedAgent = opts.agent; return prompt(sid, opts); };
  const focused = await run("TOOL then say READY", { engineProfile: "focused" });
  const focusedAgent = selectedAgent;
  const scoped = await run("TOOL then say READY", { engineProfile: "scoped" });
  const scopedAgent = selectedAgent;
  engine.prompt = prompt;
  check("focused workers select a configured, restricted engine agent", focusedAgent === "omniwork-worker" && /^READY/.test(focused.agent.lastText) && !focused.events.some(e=>e.type === "error"));
  const profile = require("../electron/engine-profile");
  check("scoped workers retain provider instructions and select their restricted agent", scopedAgent === "omniwork-scoped" && /^READY/.test(scoped.agent.lastText) && !profile.config({compact:false}).prompt);
  check("focused plan mode keeps shell and edits denied", profile.permissions("plan").filter(p=>["bash","edit","write","apply_patch"].includes(p.permission)).every(p=>p.action === "deny"));
  check("focused workers omit recursive and unrelated tools", profile.config().permission["*"] === "deny" && !profile.CORE.some(t=>["task","skill","question"].includes(t)));

  let asked = null;
  const perm = await run("PERMISSION then say READY", { approvalMode: "ask", approver: async (id, name, args) => { asked = { id, name, args }; return false; } });
  check("in ask mode a permission request reaches the approver", asked && asked.name === "bash" && asked.args.command === "rm -rf build");
  check("…and a refusal is sent back as reject", perm.agent.lastText === "permission was rejected");
  const permAuto = await run("PERMISSION then say READY");
  check("in auto mode permissions are granted without asking", /^READY/.test(permAuto.agent.lastText));

  const failed = await run("FAIL");
  check("a session error becomes an error event naming OpenCode", failed.events.some((e) => e.type === "error" && /OpenCode/.test(e.message) && /upstream exploded/.test(e.message)));

  const slowEvents = [];
  const slow = new opencode.OpenCodeAgent({ workspace, emit: (type, p) => slowEvents.push({ type, ...p }) });
  const turn = slow.send("SLOW then say READY");
  await new Promise((r) => setTimeout(r, 300));
  slow.abort();
  await turn;
  check("abort ends the turn as aborted", slowEvents.some((e) => e.type === "aborted") && !slowEvents.some((e) => e.type === "done"));

  // ── getting the binary: discovery order and the release download ──
  check("the env override is the first candidate", opencode.candidates()[0] === FAKE);
  check("a clone's node_modules binary and the data-dir download are looked for by absolute path", opencode.candidates().some((c) => /node_modules\/opencode-(darwin|linux|windows)-(arm64|x64)\/bin\/opencode/.test(c)) && opencode.candidates().includes(path.join(opencode.DOWNLOAD_DIR, process.platform === "win32" ? "opencode.exe" : "opencode")));
  check("the platform package and its lockfile integrity are pinned", /^opencode-(darwin|linux|windows)-(arm64|x64)$/.test(opencode.platformPackage()) && /^sha512-/.test(opencode.lockEntry(opencode.platformPackage()).integrity) && /^\d+\.\d+\.\d+$/.test(opencode.pinnedVersion()));
  {
    // A fake npm registry: a .tgz laid out like the real platform package
    // (package/bin/opencode) whose sha512 we know — and one we lie about.
    const relDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-release-"));
    const stage = path.join(relDir, "package", "bin"); fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "opencode"), "#!/bin/sh\necho fake-release 9.9.9\n"); fs.chmodSync(path.join(stage, "opencode"), 0o755);
    const { execFileSync } = require("node:child_process");
    await require("tar").c({ gzip: true, file: path.join(relDir, "pkg.tgz"), cwd: relDir }, ["package"]);
    const digest = crypto.createHash("sha512").update(fs.readFileSync(path.join(relDir, "pkg.tgz"))).digest("base64");
    const rel = http.createServer((req, res) => { const p = path.join(relDir, path.basename(req.url)); if (fs.existsSync(p)) { res.writeHead(200, { "Content-Length": fs.statSync(p).size }); fs.createReadStream(p).pipe(res); } else { res.writeHead(404); res.end(); } });
    await new Promise((r) => rel.listen(0, "127.0.0.1", r));
    const resolved = `http://127.0.0.1:${rel.address().port}/pkg.tgz`;
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dl-"));
    const phases = [];
    const bin = await opencode.download({ pkg: "opencode-fake-x64", dir: dest, entry: { integrity: `sha512-${digest}`, resolved, version: "9.9.9" }, onProgress: (p) => phases.push(p.phase) });
    check("download() fetches the package, verifies its sha512, unpacks the binary, and returns it", bin === path.join(dest, "opencode") && fs.statSync(bin).mode & 0o111 && execFileSync(bin, ["--version"], { encoding: "utf8" }).includes("9.9.9"));
    check("…reporting download, extract and done", phases.includes("download") && phases.includes("extract") && phases[phases.length - 1] === "done");
    check("…and leaves no archive behind", !fs.readdirSync(dest).some((n) => /\.tgz|\.part$/.test(n)));
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dl-bad-"));
    let refused = null;
    try { await opencode.download({ pkg: "opencode-fake-x64", dir: bad, entry: { integrity: "sha512-" + "A".repeat(86) + "==", resolved, version: "9.9.9" } }); } catch (e) { refused = e.message; }
    check("a hash mismatch refuses the download and installs nothing", refused && /integrity/.test(refused) && !fs.existsSync(path.join(bad, "opencode")) && !fs.readdirSync(bad).length);
    rel.close();
  }
  check("the event stream for a workspace is closed once its last subscriber leaves", engine.pumps.size === 0);

  const pickled = await run("say READY", { model: "opencode/big-pickle" });
  check("a pinned engine model is honoured", /opencode\/big-pickle/.test(pickled.agent.lastText));
  engine.stop();

  // ── ACP: gateway 503s → engine ──
  const gw = await deadPoolGateway();
  const env = { ...process.env, OMNIWORK_NO_PREWARM: "1", OMNIWORK_BASE_URL: gw.baseUrl, OMNIWORK_MODEL: "", OMNIWORK_OPENCODE_BIN: FAKE };
  delete env.OMNIWORK_MODEL_FALLBACKS;
  const acp = rpcClient(path.join(__dirname, "..", "electron", "acp-server.js"), env);
  const init = await acp.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
  check("ACP offers opencode as an auth method", init.result.authMethods.some((m) => m.id === "opencode"));
  const made = await acp.rpc("session/new", { cwd: workspace, mcpServers: [] });
  const opt = made.result.configOptions.find((o) => o.id === "model");
  check("ACP lists engine models as options", opt.options.some((o) => o.value === "opencode/nemotron-3.5-lightning-free" && /engine/.test(o.description || "")));
  const sid = made.result.sessionId;
  await acp.rpc("session/set_mode", { sessionId: sid, modeId: "auto" });
  const turn1 = await acp.rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "say READY" }] });
  const text1 = acp.updates("agent_message_chunk").map((u) => u.params.update.content.text).join("");
  check("a turn nothing on the gateway can serve finishes on the engine", turn1.result && turn1.result.stopReason === "end_turn" && /READY from opencode\/nemotron-3.5-lightning-free/.test(text1));
  check("…after telling the client why", /no gateway model answered/.test(text1));
  const cfg = acp.updates("config_option_update");
  check("…and the model option now shows the engine model", cfg.length && cfg[cfg.length - 1].params.update.configOptions[0].currentValue === "opencode/nemotron-3.5-lightning-free");
  const sw = await acp.rpc("session/set_config_option", { sessionId: sid, configId: "model", value: "opencode/big-pickle" });
  check("switching to another engine model works", !sw.error && sw.result.configOptions[0].currentValue === "opencode/big-pickle");
  const before = acp.updates("agent_message_chunk").length;
  await acp.rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "say READY" }] });
  const text2 = acp.updates("agent_message_chunk").slice(before).map((u) => u.params.update.content.text).join("");
  check("…and the next turn runs on it", /opencode\/big-pickle/.test(text2));
  const back = await acp.rpc("session/set_config_option", { sessionId: sid, configId: "model", value: "auto" });
  check("switching back to a gateway model rebuilds the gateway agent", !back.error && back.result.configOptions[0].currentValue === "auto");
  acp.proc.kill();

  // ── MCP: delegate on an engine model, and the fallback ──
  const mcp = rpcClient(path.join(__dirname, "..", "electron", "mcp-server.js"), env);
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const d1 = await mcp.rpc("tools/call", { name: "delegate", arguments: { task: "say READY", cwd: workspace, model: "opencode/big-pickle" } });
  check("MCP delegate runs a pinned engine model", !d1.result.isError && /READY from opencode\/big-pickle/.test(d1.result.content[0].text));
  const paid = await mcp.rpc("tools/call", { name: "delegate", arguments: { task: "say READY", cwd: workspace, model: "opencode/openai/connected-coder" } });
  check("an explicitly selected connected account model reaches the right provider", /READY from openai\/connected-coder/.test(paid.result.content[0].text));
  const d2 = await mcp.rpc("tools/call", { name: "delegate", arguments: { task: "say READY", cwd: workspace } });
  check("MCP delegate falls through to the engine when the gateway has nothing", !d2.result.isError && /READY from opencode\/nemotron-3.5-lightning-free/.test(d2.result.content[0].text) && d2.result.structuredContent.attempts.length === 2);
  const lm = await mcp.rpc("tools/call", { name: "list_models", arguments: {} });
  check("list_models shows engine models with access metadata", /no account/.test(lm.result.content[0].text) && /opencode\/nemotron-3.5-lightning-free/.test(lm.result.content[0].text));
  const cp = await mcp.rpc("tools/call", { name: "connect_provider", arguments: { provider: "opencode" } });
  check("connect_provider('opencode') reports the engine instead of installing", /OpenCode is installed/.test(cp.result.content[0].text));
  mcp.proc.kill();
  gw.close();

  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ OPENCODE ENGINE TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e); process.exit(1); });
