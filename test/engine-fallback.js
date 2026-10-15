"use strict";
// When no gateway model answers. The regressions: a 502 — what an `auto/*`
// pool returns when every member failed — wasn't recognised as "no model
// answered", so the OpenCode engine fallback never ran and ACP showed no
// hint; and a failed streaming request was retried without streaming, so a
// 502 walked the whole failing pool twice.
//
// Run: node test/engine-fallback.js
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

const FAKE = path.join(__dirname, "fixtures", "fake-opencode.js");
const { Agent, isNoModelFailure } = require("../electron/agent");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-nomodel-"));

function gateway(status) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith("/v1/models")) return json(200, { data: [{ id: "auto/best-chat" }] });
      if (req.url.startsWith("/api/providers")) return json(200, { connections: [] });
      calls.push(JSON.parse(raw || "{}"));
      json(status, { error: { message: "All combo targets failed", type: "server_error" }, diagnostics: { poolSize: 3, attempted: 3 } });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls, close: () => server.close() })));
}

function rpcClient(file, env) {
  const proc = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"], env });
  const pending = new Map(); const notes = []; let id = 0; let buf = "";
  proc.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && m.method === undefined) { pending.get(m.id)?.(m); pending.delete(m.id); } else if (m.method) notes.push(m); } });
  const rpc = (method, params, ms = 60_000) => new Promise((res, rej) => { const i = ++id; pending.set(i, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(method + " timed out")); } }, ms); });
  return { proc, rpc, updates: (t) => notes.filter((n) => n.method === "session/update" && n.params.update.sessionUpdate === t) };
}

(async () => {
  // ── what counts as "no model answered" ──
  for (const [msg, want] of [
    ["Gateway 502: All combo targets failed", true], ["Gateway 503: no providers", true], ["Gateway 504: combo timeout", true],
    ["Gateway 401: invalid key", true], ["All models failed:\n- a: x", true], ["m: empty response", true],
    ["Gateway 429: rate limited", false], ["Gateway 500: oops", false], ["Gateway 5023: not a status", false], ["Error in run_command: exit 1", false],
  ]) check(`${JSON.stringify(msg.split(":")[0])} → ${want ? "no model answered" : "something else"}`, isNoModelFailure(msg) === want);

  // ── a failed pool is asked once per model, not again without streaming ──
  for (const status of [502, 503, 504]) {
    const gw = await gateway(status);
    const agent = new Agent({ baseUrl: gw.baseUrl, apiKey: "t", model: "auto/best-chat", workspace, canSpawn: false, streaming: true, tiers: false, emit: () => {} });
    await agent.send("hi");
    check(`a streaming ${status} is not retried without streaming`, gw.calls.length === 1 && gw.calls[0].stream === true);
    gw.close();
  }
  {
    const gw = await gateway(500);
    const agent = new Agent({ baseUrl: gw.baseUrl, apiKey: "t", model: "solo/model", workspace, canSpawn: false, streaming: true, tiers: false, emit: () => {} });
    await agent.send("hi");
    check("other failures still get the non-streaming retry", gw.calls.length === 2 && gw.calls[1].stream === false);
    gw.close();
  }

  // ── ACP: a 502 turn finishes on the OpenCode engine ──
  {
    const gw = await gateway(502);
    const env = { ...process.env, OMNIWORK_NO_PREWARM: "1", OMNIWORK_BASE_URL: gw.baseUrl, OMNIWORK_MODEL: "", OMNIWORK_OPENCODE_BIN: FAKE, OMNIWORK_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-nomodel-data-")) };
    delete env.OMNIWORK_MODEL_FALLBACKS;
    const acp = rpcClient(path.join(__dirname, "..", "electron", "acp-server.js"), env);
    await acp.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const made = await acp.rpc("session/new", { cwd: workspace, mcpServers: [], _meta: { omniwork: { mode: "auto" } } });
    const turn = await acp.rpc("session/prompt", { sessionId: made.result.sessionId, prompt: [{ type: "text", text: "say READY" }] });
    const text = acp.updates("agent_message_chunk").map((u) => u.params.update.content.text).join("");
    check("an ACP turn the gateway answers with 502 finishes on the engine", turn.result && turn.result.stopReason === "end_turn" && /READY from opencode\//.test(text) && /no gateway model answered/.test(text));
    acp.proc.kill();

    const env2 = { ...env, OMNIWORK_ENGINE_FALLBACK: "off" };
    const acp2 = rpcClient(path.join(__dirname, "..", "electron", "acp-server.js"), env2);
    await acp2.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const made2 = await acp2.rpc("session/new", { cwd: workspace, mcpServers: [], _meta: { omniwork: { mode: "auto" } } });
    const failed = await acp2.rpc("session/prompt", { sessionId: made2.result.sessionId, prompt: [{ type: "text", text: "say READY" }] });
    const shown = acp2.updates("agent_message_chunk").map((u) => u.params.update.content.text).join("");
    check("without the engine, a 502 ends the turn with the how-to-connect hint", !failed.error && failed.result._meta.omniwork.error.noModel === true && /Gateway 502/.test(shown) && /No model answered/.test(shown));
    acp2.proc.kill();
    gw.close();
  }

  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ NO-MODEL FALLBACK TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
