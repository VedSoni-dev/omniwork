"use strict";
// The ACP permission boundary, end to end: omniwork-acp over stdio, a fake
// client that answers session/request_permission, and a scripted fake gateway.
// The regressions:
//   - "Allow always" switched the whole session to auto, so one approved edit
//     meant every later command ran unasked;
//   - a subagent's permission request named a tool call the client was never
//     told about;
//   - a `cancelled` answer let the turn carry on; there was no reject_always;
//   - the client's mcpServers were silently ignored;
//   - a model failure came back as a JSON-RPC error (now a stop reason;
//     OMNIWORK_ACP_ERRORS=rpc keeps the old way for a release).
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

// The gateway answers from a queue the test fills before each prompt; every
// request is recorded.
const queue = [];
const requests = [];
const toolCall = (name, args) => ({ content: "", tool_calls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const say = (text) => ({ content: text });

function acpProcess(env) {
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "electron", "acp-server.js")], { stdio: ["pipe", "pipe", "pipe"], env });
  const pending = new Map(), notes = [], asked = [];
  let nextId = 1, buf = "";
  let answer = () => ({ outcome: { outcome: "selected", optionId: "reject_once" } });
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.method === "session/request_permission") {
        // Was the tool call announced before we were asked about it?
        const announced = notes.some((n) => n.method === "session/update" && n.params.update.sessionUpdate === "tool_call" && n.params.update.toolCallId === m.params.toolCall.toolCallId);
        asked.push({ ...m.params, announced });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer(m.params) }) + "\n");
      } else if (m.id != null && m.method === undefined) { pending.get(m.id)?.(m); pending.delete(m.id); }
      else if (m.method) notes.push(m);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + " timed out")); } }, 30_000);
  });
  return { proc, rpc, notes, asked, setAnswer: (fn) => { answer = fn; }, updates: (t) => notes.filter((n) => n.method === "session/update" && n.params.update.sessionUpdate === t) };
}

(async () => {
  const gw = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.startsWith("/v1/models")) return res.end('{"data":[{"id":"fake/agent"}]}');
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      const next = queue.shift() || say("done");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...next }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-acpp-data-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-acpp-ws-"));
  const env = { ...process.env, OMNIWORK_DATA_DIR: dataDir, OMNIWORK_NO_PREWARM: "1", OMNIWORK_BASE_URL: `http://127.0.0.1:${gw.address().port}/v1`, OMNIWORK_MODEL: "fake/agent", OMNIWORK_MODEL_FALLBACKS: "", OMNIWORK_ENGINE_FALLBACK: "off" };
  delete env.OMNIWORK_ACP_ERRORS;

  const c = acpProcess(env);
  await c.rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
  const made = await c.rpc("session/new", { cwd: ws, mcpServers: [] });
  const sid = made.result.sessionId;
  const prompt = (text) => c.rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] });

  // ── reject_once: the edit doesn't happen, and the next one asks again ──
  queue.push(toolCall("write_file", { path: "a.txt", content: "A" }), toolCall("write_file", { path: "b.txt", content: "B" }), say("done"));
  await prompt("write two files");
  check("ask mode asks before each edit", c.asked.length === 2 && c.asked.every((a) => a.toolCall.kind === "edit"));
  check("…about a tool call the client was told about first", c.asked.every((a) => a.announced));
  check("a rejected edit is not made", !fs.existsSync(path.join(ws, "a.txt")) && !fs.existsSync(path.join(ws, "b.txt")));
  check("reject_always is offered", c.asked[0].options.some((o) => o.kind === "reject_always"));

  // ── allow_always applies to that tool, not the whole session ──
  c.asked.length = 0;
  c.setAnswer((p) => ({ outcome: { outcome: "selected", optionId: p.toolCall.kind === "edit" ? "allow_always" : "reject_once" } }));
  queue.push(toolCall("write_file", { path: "c.txt", content: "C" }), toolCall("write_file", { path: "d.txt", content: "D" }), toolCall("run_command", { command: "echo should-not-run > ran.txt" }), say("done"));
  await prompt("write and run");
  check("after allow_always, later edits run without asking", fs.existsSync(path.join(ws, "c.txt")) && fs.existsSync(path.join(ws, "d.txt")) && c.asked.filter((a) => a.toolCall.kind === "edit").length === 1);
  check("…but a command still asks, and its rejection holds", c.asked.some((a) => a.toolCall.kind === "execute") && !fs.existsSync(path.join(ws, "ran.txt")));
  check("…and the session never switched to auto", !c.updates("current_mode_update").some((n) => n.params.update.currentModeId === "auto"));

  // ── a command is remembered as that exact command ──
  c.asked.length = 0;
  c.setAnswer(() => ({ outcome: { outcome: "selected", optionId: "allow_always" } }));
  queue.push(toolCall("run_command", { command: "echo one >> cmd.txt" }), toolCall("run_command", { command: "echo one >> cmd.txt" }), toolCall("run_command", { command: "echo two >> cmd.txt" }), say("done"));
  await prompt("commands");
  check("an always-allowed command runs again unasked; a different one asks", c.asked.length === 2 && fs.readFileSync(path.join(ws, "cmd.txt"), "utf8") === "one\none\ntwo\n");

  // ── reject_always and the network tools ──
  c.asked.length = 0;
  c.setAnswer(() => ({ outcome: { outcome: "selected", optionId: "reject_always" } }));
  queue.push(toolCall("web_fetch", { url: "http://127.0.0.1:9/exfil?x=1" }), toolCall("web_fetch", { url: "http://127.0.0.1:9/again" }), toolCall("save_memory", { scope: "global", title: "t", content: "x" }), say("done"));
  await prompt("fetch");
  check("web_fetch asks in ask mode", c.asked.some((a) => a.toolCall.kind === "fetch"));
  check("…and reject_always stops it asking again", c.asked.filter((a) => a.toolCall.kind === "fetch").length === 1);
  check("save_memory asks too", c.asked.some((a) => /Remember/.test(a.toolCall.title)));

  // ── cancelled stops the turn ──
  // (Commands this session hasn't approved: write_file is always-allowed by now.)
  c.asked.length = 0;
  c.setAnswer(() => ({ outcome: { outcome: "cancelled" } }));
  queue.push(toolCall("run_command", { command: "echo E > e.txt" }), toolCall("run_command", { command: "echo F > f.txt" }), say("done"));
  const cancelled = await prompt("cancel me");
  check("a cancelled permission request ends the turn as cancelled", cancelled.result.stopReason === "cancelled" && c.asked.length === 1 && !fs.existsSync(path.join(ws, "e.txt")) && !fs.existsSync(path.join(ws, "f.txt")));
  queue.length = 0;

  // ── a subagent's request names a tool call the client has seen ──
  c.asked.length = 0;
  c.setAnswer(() => ({ outcome: { outcome: "selected", optionId: "reject_once" } }));
  queue.push(toolCall("spawn_subagents", { tasks: [{ title: "worker", prompt: "write g" }] }));
  c.setAnswer((p) => ({ outcome: { outcome: "selected", optionId: p.toolCall.kind === "think" ? "allow_once" : "reject_once" } }));
  // The subagent's command, not yet approved in this session:
  queue.push(toolCall("run_command", { command: "echo G > g.txt" }), say("sub done"), say("all done"));
  await prompt("fan out");
  const subAsk = c.asked.find((a) => a.toolCall.kind === "execute");
  check("a subagent's tool asks with a tool call announced first", subAsk && subAsk.announced && !fs.existsSync(path.join(ws, "g.txt")));
  check("…and that tool call is closed out", c.updates("tool_call_update").some((n) => n.params.update.toolCallId === subAsk?.toolCall.toolCallId && n.params.update.status === "failed"));
  queue.length = 0;

  // ── the client's MCP servers ──
  const fakeMcp = path.join(dataDir, "fake-mcp.js");
  fs.writeFileSync(fakeMcp, `
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); handle(m); } });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
function handle(m) {
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echoed:" + m.params.arguments.text }] } });
}`);
  const withMcp = await c.rpc("session/new", { cwd: ws, mcpServers: [{ name: "fake", command: process.execPath, args: [fakeMcp], env: [] }] });
  await settle(1500);
  c.setAnswer(() => ({ outcome: { outcome: "selected", optionId: "allow_once" } }));
  requests.length = 0;
  queue.push(toolCall("mcp__fake__echo", { text: "hi" }), say("done"));
  await c.rpc("session/prompt", { sessionId: withMcp.result.sessionId, prompt: [{ type: "text", text: "use the tool" }] });
  check("the client's MCP server tools are offered to the model", (requests[0]?.tools || []).some((t) => t.function.name === "mcp__fake__echo"));
  check("…and called through it", requests.some((r) => r.messages.some((m) => m.role === "tool" && /echoed:hi/.test(m.content))));
  const httpMcp = await c.rpc("session/new", { cwd: ws, mcpServers: [{ type: "http", name: "remote", url: "https://example.test/mcp", headers: [] }] });
  check("an http MCP server is refused, not silently dropped", httpMcp.error && httpMcp.error.code === -32602);

  // ── model failures are stop reasons ──
  c.proc.kill();
  const strict = acpProcess(env);
  await strict.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const s1 = await strict.rpc("session/new", { cwd: ws, mcpServers: [], _meta: { omniwork: { honorClientCapabilities: true } } });
  const tools = s1.result._meta.omniwork.tools;
  check("strict capabilities drop tools the client doesn't host", s1.result._meta.omniwork.capabilityPolicy === "strict" && !tools.includes("run_command") && !tools.includes("write_file") && !tools.includes("read_file"));
  const s2 = await strict.rpc("session/new", { cwd: ws, mcpServers: [] });
  check("by default the agent's own tools stay (most clients declare none)", s2.result._meta.omniwork.capabilityPolicy === "local" && s2.result._meta.omniwork.tools.includes("run_command"));
  strict.proc.kill();

  // ── the OpenCode engine asks about its own tool call, not a "subagent" ──
  const eng = acpProcess({ ...env, OMNIWORK_OPENCODE_BIN: path.join(__dirname, "fixtures", "fake-opencode.js") });
  await eng.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const es = await eng.rpc("session/new", { cwd: ws, mcpServers: [], _meta: { model: "opencode/big-pickle" } });
  eng.setAnswer(() => ({ outcome: { outcome: "selected", optionId: "reject_once" } }));
  await eng.rpc("session/prompt", { sessionId: es.result.sessionId, prompt: [{ type: "text", text: "PERMISSION then say READY" }] });
  const engAsk = eng.asked[0];
  check("an engine permission request names a tool call announced first", engAsk && engAsk.announced);
  check("…not labelled as a subagent", engAsk && !eng.updates("tool_call").some((n) => /^subagent:/.test(n.params.update.title)));
  check("…and the refused call is closed out", engAsk && eng.updates("tool_call_update").some((n) => n.params.update.toolCallId === engAsk.toolCall.toolCallId && n.params.update.status === "failed"));
  eng.proc.kill();

  gw.close();
  const dead = acpProcess({ ...env, OMNIWORK_BASE_URL: "http://127.0.0.1:9/v1", OMNIWORK_ACP_ERRORS: "rpc" });
  await dead.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const d1 = await dead.rpc("session/new", { cwd: ws, mcpServers: [] });
  const legacy = await dead.rpc("session/prompt", { sessionId: d1.result.sessionId, prompt: [{ type: "text", text: "hi" }] });
  check("OMNIWORK_ACP_ERRORS=rpc keeps the old JSON-RPC error for a release", Boolean(legacy.error) && legacy.error.code === -32000);
  dead.proc.kill();

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ ACP PERMISSIONS TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
