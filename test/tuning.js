"use strict";
// The token-economy levers (electron/tuning.js + the agent wiring), against a
// fake OpenAI-compatible gateway that records every request. Deterministic — no
// real models, no network.
//
//   1. compression is enabled via a PUT, with a minimal-payload fallback
//   2. housekeeping (oneShot) runs on the utility model, not the session model
//   3. a stalling fast tier escalates to the coding tier
//   4. a 429 cools a model and rotates without a permanent switch
//   6. every request carries a stable x-session-id for prompt-cache affinity
//
// Run: node test/tuning.js
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tuning = require("../electron/tuning");
const { Agent } = require("../electron/agent");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-tuning-"));
const reply = (text) => ({ choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
const toolCall = (cmd) => ({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c" + Math.random().toString(36).slice(2, 6), type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: cmd }) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });

// route(body, req, calls) → response object; every chat request is recorded.
function gateway(route) {
  const chats = [];       // { model, sessionId }
  const puts = [];        // compression PUT bodies
  let putStatus = () => 200;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/settings/compression") { const b = JSON.parse(raw || "{}"); puts.push(b); const st = putStatus(b); return json(st, st === 200 ? b : { error: "bad" }); }
    if (req.url.endsWith("/chat/completions")) {
      const b = JSON.parse(raw || "{}");
      chats.push({ model: b.model, sessionId: req.headers["x-session-id"] });
      const out = route(b, chats);
      if (out.status && out.status !== 200) return json(out.status, out.body || { error: { message: out.message || "err" } });
      return json(200, out.json || out);
    }
    json(404, {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, chats, puts, setPutStatus: (fn) => { putStatus = fn; }, close: () => server.close() })));
}

(async () => {
  // ── unit: selection logic ──
  check("utilityModel redirects the auto pools to the fast pool", tuning.utilityModel("auto") === "auto/best-fast" && tuning.utilityModel("auto/best-coding") === "auto/best-fast");
  check("utilityModel respects a pinned model", tuning.utilityModel("groq/llama-3.3-70b") === "groq/llama-3.3-70b");
  check("tiers are on for auto, off for a pinned model", tuning.tiersFor("auto") && tuning.tiersFor("auto").fast === "auto/best-fast" && tuning.tiersFor("groq/x") === null);
  check("toolFailed recognises real failure shapes", tuning.toolFailed("Error in run_command: x") && tuning.toolFailed("boom\n\n[exit code 1]") && tuning.toolFailed("ls: /x: No such file or directory") && tuning.toolFailed("bash: foo: command not found"));
  check("toolFailed finds a non-zero exit code even after truncation keeps only the tail", tuning.toolFailed("first line\n… [truncated 90000 chars]\nlast line\n\n[exit code 5]"));
  check("toolFailed does NOT fire on success or on the phrase inside normal output", !tuning.toolFailed("done\n\n[exit code 0]") && !tuning.toolFailed("grepping for: No such file or directory as a string") && !tuning.toolFailed("all good"));
  check("shouldVerify gates on real changes or write-intent wording", tuning.shouldVerify("summarize the readme", false) === false && tuning.shouldVerify("summarize the readme", true) === true && tuning.shouldVerify("implement a login form", false) === true && tuning.shouldVerify("refactor the parser", false) === true);

  // ── 1: compression enable, with the minimal fallback ──
  {
    const g = await gateway(() => reply("hi"));
    check("enableCompression PUTs and turns it on", (await tuning.enableCompression(g.baseUrl, "k")) === true && g.puts.length === 1 && g.puts[0].defaultMode === "rtk");
    g.setPutStatus((b) => (b.engines ? 400 : 200)); // reject the rich payload, accept minimal
    const ok = await tuning.enableCompression(g.baseUrl, "k");
    check("…falls back to the minimal payload when the rich one is rejected", ok === true && g.puts.length === 3 && !g.puts[2].engines);
    g.close();
  }
  {
    const prev = process.env.OMNIWORK_COMPRESSION; process.env.OMNIWORK_COMPRESSION = "off";
    const g = await gateway(() => reply("hi"));
    check("OMNIWORK_COMPRESSION=off skips the PUT entirely", (await tuning.enableCompression(g.baseUrl, "k")) === false && g.puts.length === 0);
    g.close(); if (prev === undefined) delete process.env.OMNIWORK_COMPRESSION; else process.env.OMNIWORK_COMPRESSION = prev;
  }

  const run = async (g, opts) => {
    const events = [];
    const agent = new Agent({ baseUrl: g.baseUrl, apiKey: "k", workspace, canSpawn: false, streaming: false, emit: (t, p) => events.push({ t, ...p }), ...opts });
    await agent.send("do the thing");
    return { agent, events };
  };

  // ── 6: stable session id on every request ──
  {
    const g = await gateway(() => reply("done"));
    const { agent } = await run(g, { model: "auto" });
    check("every request carries the same x-session-id", g.chats.length >= 1 && g.chats.every((c) => c.sessionId && c.sessionId === agent.sessionId));
    g.close();
  }

  // ── 3: fast tier by default, escalation after two failed steps ──
  {
    // step 0: a failing command; step 1: another; step 2: final answer.
    const g = await gateway((b, chats) => {
      const n = chats.length - 1;
      if (n === 0) return toolCall("false");           // fails -> [exit code 1]
      if (n === 1) return toolCall("ls /nope/nope");   // fails -> ENOENT
      return reply("finished");
    });
    const { agent, events } = await run(g, { model: "auto" });
    check("the turn starts on the fast tier", g.chats[0].model === "auto/best-fast");
    check("two failed steps escalate to the coding tier", agent.model === "auto/best-coding" && g.chats[g.chats.length - 1].model === "auto/best-coding");
    check("…and the escalation is announced", events.some((e) => e.t === "system" && /escalating to the coding tier/.test(e.content)));
    g.close();
  }

  // ── 3: a pinned model never tiers ──
  {
    const g = await gateway(() => reply("done"));
    const { agent } = await run(g, { model: "groq/llama-3.3-70b" });
    check("a pinned model runs as itself, no tiering", g.chats.every((c) => c.model === "groq/llama-3.3-70b") && agent.model === "groq/llama-3.3-70b");
    g.close();
  }

  // ── 2: oneShot uses the utility model, and falls back once if unknown ──
  {
    const g = await gateway((b) => (b.model === "auto/best-fast" ? { status: 404, message: "no such model" } : reply("Fix login")));
    const agent = new Agent({ baseUrl: g.baseUrl, apiKey: "k", workspace, model: "auto", emit: () => {} });
    const out = await agent.oneShot("name this");
    check("oneShot targets the utility model", g.chats[0].model === "auto/best-fast");
    check("…and falls back to the session model when the utility id is unknown", g.chats[1] && g.chats[1].model === "auto" && out === "Fix login");
    g.close();
  }

  // ── 4: a 429 cools the model and rotates without a permanent switch ──
  {
    let primaryHits = 0;
    const g = await gateway((b) => {
      if (b.model === "auto") { primaryHits++; return { status: 429, message: "rate limited" }; }
      return reply("via fallback");
    });
    const events = [];
    const agent = new Agent({ baseUrl: g.baseUrl, apiKey: "k", workspace, model: "auto", fallbackModels: ["backup/model"], canSpawn: false, streaming: false, tiers: null, emit: (t, p) => events.push({ t, ...p }) });
    await agent.send("go");
    check("a 429 on the primary rotates to the fallback for the answer", agent.lastText === "via fallback");
    check("…but the primary is NOT permanently switched away", agent.model === "auto" && agent.modelSwitches.length === 0);
    check("…and the primary is marked cooling", agent.cooling.get("auto") > Date.now());
    g.close();
  }

  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ TUNING TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e); process.exit(1); });
