"use strict";
// The model fallback chain, against a fake OpenAI-compatible gateway (no
// OmniRoute boot): a model the gateway rejects — retired id, missing provider
// key, quota — hands the same request to the next model; the switch sticks for
// the session; when every model fails the error names each one. Also pins the
// pre-existing behaviour it must not break: a provider that rejects streaming
// still gets the non-streaming retry on the *same* model, and a dead gateway is
// not a reason to walk the chain.
//
// Run: node test/fallback.js
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Agent } = require("../electron/agent");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

const reply = (text) => ({ status: 200, json: { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
const retired = (m) => ({ status: 401, json: { error: { message: `[401]: Model ${m} is not supported`, type: "authentication_error", code: "invalid_api_key" } } });

// route(body) → { status, json }; every request is recorded in `calls`.
function gateway(route) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      calls.push({ model: body.model, stream: Boolean(body.stream) });
      const out = route(body);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls, close: () => server.close() });
  }));
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-fallback-"));

async function turn(gw, opts, prompt = "hi") {
  const events = [];
  const agent = new Agent({ baseUrl: gw.baseUrl, apiKey: "test", workspace, canSpawn: false, streaming: false, ...opts, emit: (type, p) => events.push({ type, ...p }) });
  await agent.send(prompt);
  return { agent, events };
}
const errorOf = (events) => (events.find((e) => e.type === "error") || {}).message || "";

(async () => {
  // ── a rejected model falls through, and the switch sticks ──
  {
    const gw = await gateway((b) => (b.model === "oc/retired-coder" ? retired(b.model) : reply(`hello from ${b.model}`)));
    const { agent, events } = await turn(gw, { model: "oc/retired-coder", fallbackModels: ["free/coder"] });
    check("a 401 on the pinned model falls through to the next one", agent.lastText === "hello from free/coder");
    check("the fallback becomes the session's model", agent.model === "free/coder");
    const sw = events.find((e) => e.type === "model_switch");
    check("the switch is emitted with from/to/reason", sw && sw.from === "oc/retired-coder" && sw.to === "free/coder" && /401/.test(sw.reason));
    check("the switch is narrated as a system message", events.some((e) => e.type === "system" && /oc\/retired-coder failed/.test(e.content)));
    check("modelSwitches records it for callers", agent.modelSwitches.length === 1 && agent.modelSwitches[0].to === "free/coder");
    const before = gw.calls.length;
    await agent.send("again");
    check("the next step does not retry the failed model", gw.calls.length === before + 1 && gw.calls[before].model === "free/coder");
    gw.close();
  }

  // ── every model fails: the error names each one ──
  {
    const gw = await gateway((b) => retired(b.model));
    const { agent, events } = await turn(gw, { model: "a/one", fallbackModels: ["b/two"] });
    const msg = errorOf(events);
    check("when the whole chain fails the turn errors", Boolean(msg));
    check("…and the error lists every model with its failure", /All models failed/.test(msg) && /a\/one: Gateway 401/.test(msg) && /b\/two: Gateway 401/.test(msg));
    check("no switch is recorded on total failure", agent.modelSwitches.length === 0 && agent.model === "a/one");
    gw.close();
  }

  // ── a single model with no chain keeps the plain error ──
  {
    const gw = await gateway((b) => retired(b.model));
    const { events } = await turn(gw, { model: "a/one" });
    check("without a chain the error is the gateway's own", /^Gateway 401/.test(errorOf(events)));
    gw.close();
  }

  // ── an empty reply is a failure while a fallback is queued ──
  {
    const gw = await gateway((b) => (b.model === "free/empty" ? reply("") : reply("real answer")));
    const { agent } = await turn(gw, { model: "free/empty", fallbackModels: ["free/ok"] });
    check("an empty response moves to the next model", agent.lastText === "real answer" && agent.model === "free/ok");
    check("…with 'empty response' as the reason", /empty response/.test(agent.modelSwitches[0].reason));
    gw.close();
  }

  // ── streaming rejected ≠ model rejected: same model, non-streaming retry ──
  {
    const gw = await gateway((b) => (b.stream ? { status: 400, json: { error: { message: "stream_options not supported" } } } : reply("nonstream")));
    const { agent } = await turn(gw, { model: "free/coder", fallbackModels: ["other/model"], streaming: true });
    check("a streaming 400 retries the same model without streaming", agent.lastText === "nonstream" && agent.modelSwitches.length === 0);
    check("…as exactly one extra request", gw.calls.length === 2 && gw.calls.every((c) => c.model === "free/coder"));
    gw.close();
  }

  // ── streaming 401 is final for that model: no non-streaming retry ──
  {
    const gw = await gateway((b) => (b.model === "oc/retired-coder" ? retired(b.model) : reply("ok")));
    const { agent } = await turn(gw, { model: "oc/retired-coder", fallbackModels: ["free/coder"], streaming: true });
    check("a streaming 401 skips the non-streaming retry and walks the chain", agent.model === "free/coder" && gw.calls.filter((c) => c.model === "oc/retired-coder").length === 1);
    gw.close();
  }

  // ── a dead gateway is not a model failure ──
  {
    const { agent, events } = await turn({ baseUrl: "http://127.0.0.1:9/v1" }, { model: "a/one", fallbackModels: ["b/two"] });
    check("a dead gateway surfaces the connection error", /connection|fetch|engine/i.test(errorOf(events)));
    check("…without walking the chain", agent.modelSwitches.length === 0);
  }

  // ── what is NOT a model failure: a malformed request fails the same on every model ──
  {
    const gw = await gateway((b) => ({ status: 400, json: { error: { message: "messages[0].content must be a string" } } }));
    const { agent, events } = await turn(gw, { model: "a/one", fallbackModels: ["b/two"] });
    check("a 400 that is not about the model does not walk the chain", /^Gateway 400/.test(errorOf(events)) && gw.calls.length === 1 && agent.modelSwitches.length === 0);
    gw.close();
  }
  {
    const gw = await gateway((b) => (b.model === "a/one" ? { status: 400, json: { error: { message: "[400]: Unsupported model one" } } } : reply("ok")));
    const { agent } = await turn(gw, { model: "a/one", fallbackModels: ["b/two"] });
    check("a 400 that names the model does", agent.model === "b/two" && agent.lastText === "ok");
    gw.close();
  }
  // Identical provider failures need not affect the next provider.
  {
    const gw = await gateway(b => b.model === "c/three" ? reply("third provider works") : { status: 403, json: { error: { message: "Access denied" } } });
    const { agent } = await turn(gw, { model: "a/one", fallbackModels: ["b/two", "c/three"] });
    check("identical provider rejections still reach a working third provider", agent.lastText === "third provider works");
    gw.close();
  }
  // ── known gateway exhaustion can short-circuit ──
  {
    const gw = await gateway(() => ({ status: 503, json: { error: { message: "Maximum combo retry limit reached" } } }));
    const { events } = await turn(gw, { model: "a/one", fallbackModels: ["b/two", "c/three", "d/four"] });
    check("identical consecutive failures short-circuit the chain", gw.calls.length === 2 && /stopped: the next model failed the same way/.test(errorOf(events)));
    gw.close();
  }
  // ── an empty reply with nothing left to try is an error, not a blank done ──
  {
    const gw = await gateway(() => reply(""));
    const { events } = await turn(gw, { model: "a/one" });
    check("an empty reply from the only model is reported as an error", /empty response/.test(errorOf(events)) && !events.some((e) => e.type === "done"));
    gw.close();
  }

  // ── chain normalisation ──
  {
    const a = new Agent({ baseUrl: "http://x", apiKey: "k", workspace, model: "p", fallbackModels: " a, b,,a ,p", emit: () => {} });
    check("a comma string becomes a deduped chain without the primary", JSON.stringify(a.fallbackModels) === JSON.stringify(["a", "b"]));
    const b = new Agent({ baseUrl: "http://x", apiKey: "k", workspace, model: "p", fallbackModels: ["p", "q"], emit: () => {} });
    check("an array chain drops the primary too", JSON.stringify(b.fallbackModels) === JSON.stringify(["q"]));
  }

  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ FALLBACK TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e); process.exit(1); });
