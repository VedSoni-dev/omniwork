#!/usr/bin/env node
"use strict";
// Real installed OpenCode, local synthetic inference: write a fixture, then
// stall the next response so a time reserve must stop it before verification.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { Engine, OpenCodeAgent, version } = require("../electron/opencode-engine");
const { executeTask } = require("../electron/execution");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-checkpoint-"));
let engine, requests = 0, checkedIdle = false;
const server = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = JSON.parse(raw); requests++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const packet = { id: `fixture-${requests}`, object: "chat.completion.chunk", created: 1, model: "coder" };
  const send = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ ...packet, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  if (body.messages.some(m => m.role === "tool")) {
    send({ role: "assistant", content: "The file is written; continuing to inspect." });
    // The engine must cancel this stream; there is no model completion event.
    return;
  }
  send({ role: "assistant", tool_calls: [{ index: 0, id: "write_fixture", type: "function", function: { name: "write", arguments: JSON.stringify({ filePath: path.join(root, "answer.txt"), content: "READY\n" }) } }] });
  send({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
  res.end("data: [DONE]\n\n");
});
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ enabled_providers: ["fixture"], small_model: "fixture/coder", provider: { fixture: {
    npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture" },
    models: { coder: { name: "Local checkpoint fixture", limit: { context: 100000, output: 2048 }, tool_call: true } },
  } } });
  engine = new Engine(); await engine.start(); await engine.models();
  let agent;
  const result = await executeTask({ task: "Write answer.txt containing READY followed by a newline.", trace: true, checks: ["fixture file equals READY"],
    maxTokens: 10000, timeoutMs: 15000, verificationReserveMs: 10000,
    createAgent: async emit => (agent = new OpenCodeAgent({ engine, workspace: root, model: "opencode/fixture/coder", engineProfile: "scoped", emit })),
    runCheck: async () => { checkedIdle = await engine.isIdle(agent.sessionID, root); const ok = checkedIdle && fs.readFileSync(path.join(root, "answer.txt"), "utf8") === "READY\n"; return { ok, exitCode: ok ? 0 : 1, text: ok ? "verified" : "failed" }; },
  });
  assert.equal(result.status, "completed", JSON.stringify({ status: result.status, reason: result.reason, completion: result.completion }));
  assert(result.completion.checkpoint.confirmed && checkedIdle); assert(requests >= 2);
  assert.equal(result.verification.status, "passed"); assert(result.elapsedMs < 15000);
  const report = { testedAt: new Date().toISOString(), engineVersion: version(), scope: "Real installed engine, synthetic local inference; verifies stop-before-check, not coding quality or token savings.", requests, checkedIdle,
    status: result.status, completion: result.completion, usage: result.usage, elapsedMs: result.elapsedMs, trace: result.trace };
  const index = process.argv.indexOf("--output");
  if (index >= 0) { fs.mkdirSync(path.dirname(process.argv[index + 1]), { recursive: true }); fs.writeFileSync(process.argv[index + 1], JSON.stringify(report, null, 2) + "\n"); }
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { engine?.stop(); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
