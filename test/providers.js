"use strict";
// Free-provider connect, against fakes: a gateway management API (in-memory
// connections; /v1/models grows with what is connected), an "OpenRouter" that
// runs the PKCE dance, and a local OpenAI-compatible server. Covers status,
// key connect with verification (a rejected key is not kept), the PKCE flow
// end to end, local detection, and the fallback chain that falls out.
//
// Run: node test/providers.js
const http = require("node:http");
const crypto = require("node:crypto");
// The engine section of status() would start a real OpenCode server when one
// is installed; pin it to the fixture so the test is hermetic.
const path = require("node:path");
process.env.OMNIWORK_OPENCODE_BIN = path.join(__dirname, "fixtures", "fake-opencode.js");
const providers = require("../electron/providers");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ""; req.on("data", (d) => { s += d; }); req.on("end", () => r(s ? JSON.parse(s) : {})); });
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// Alias → what a connected provider "exposes", mirroring OmniRoute's alias/<model> ids.
const ALIAS = { openrouter: "openrouter", groq: "groq", "ollama-local": "ollama", gemini: "gemini" };
const EXPOSES = {
  openrouter: ["~deepseek/deepseek-pro-latest", "cohere/north-mini-code:free", "google/gemma-4-31b-it:free", "openai/gpt-5"],
  groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
  gemini: ["gemini-2.5-flash"],
  "ollama-local": ["qwen2.5-coder:7b"],
};

// ── fake gateway ──
function fakeGateway() {
  const conns = [];
  const chats = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/api/providers") return json(res, 200, { connections: conns.map((c) => ({ ...c, apiKey: "****" })) });
    if (req.method === "POST" && u.pathname === "/api/providers") {
      const b = await readBody(req);
      const c = { id: crypto.randomUUID(), provider: b.provider, authType: b.authType, name: b.name, apiKey: b.apiKey, isActive: true, providerSpecificData: b.providerSpecificData || null };
      conns.push(c);
      return json(res, 200, { connection: { ...c, apiKey: undefined } });
    }
    if (req.method === "PATCH" && u.pathname.startsWith("/api/providers/")) {
      const id = u.pathname.split("/").pop(); const c = conns.find((x) => x.id === id); const b = await readBody(req);
      if (!c) return json(res, 404, { error: { message: "not found" } });
      if (typeof b.isActive === "boolean") c.isActive = b.isActive;
      return json(res, 200, { connection: { ...c, apiKey: undefined } });
    }
    if (req.method === "DELETE" && u.pathname.startsWith("/api/providers/")) {
      const id = u.pathname.split("/").pop(); const i = conns.findIndex((c) => c.id === id);
      if (i < 0) return json(res, 404, { error: { message: "not found" } });
      conns.splice(i, 1); return json(res, 200, { message: "deleted" });
    }
    if (u.pathname === "/v1/models") {
      const ids = ["auto", "auto/best-coding"];
      for (const c of conns) if (c.isActive !== false) for (const m of EXPOSES[c.provider] || []) ids.push(`${ALIAS[c.provider]}/${m}`);
      return json(res, 200, { data: ids.map((id) => ({ id })) });
    }
    if (u.pathname === "/v1/chat/completions") {
      const b = await readBody(req);
      chats.push(b.model);
      const alias = b.model.split("/")[0];
      const c = conns.find((x) => ALIAS[x.provider] === alias && x.isActive !== false);
      if (!c) return json(res, 404, { error: { message: "no such model" } });
      if (c.apiKey === "bad-key") return json(res, 401, { error: { message: "invalid api key" } });
      return json(res, 200, { choices: [{ message: { role: "assistant", content: "READY" } }] });
    }
    json(res, 404, { error: { message: "unknown route " + u.pathname } });
  });
  return listen(server).then((port) => ({ gw: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test" }, conns, chats, close: () => server.close() }));
}

// ── fake OpenRouter: /auth "signs the user in" by hitting our callback; /api/v1/auth/keys checks PKCE ──
function fakeOpenRouter() {
  let challenge = null;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/auth") {
      challenge = u.searchParams.get("code_challenge");
      const cb = new URL(u.searchParams.get("callback_url")); cb.searchParams.set("code", "code-123");
      const r = await fetch(cb); await r.text();
      return json(res, 200, { ok: true });
    }
    if (u.pathname === "/api/v1/auth/keys") {
      const b = await readBody(req);
      const expect = Buffer.from(crypto.createHash("sha256").update(b.code_verifier || "").digest()).toString("base64url");
      if (b.code !== "code-123" || b.code_challenge_method !== "S256" || expect !== challenge) return json(res, 403, { error: "Invalid code or code_verifier" });
      return json(res, 200, { key: "sk-or-v1-from-pkce" });
    }
    json(res, 404, {});
  });
  return listen(server).then((port) => ({ base: `http://127.0.0.1:${port}`, close: () => server.close() }));
}

function fakeLocal() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/v1/models")) return json(res, 200, { data: [{ id: "qwen2.5-coder:7b" }, { id: "llama3.2:3b" }] });
    json(res, 200, { choices: [{ message: { content: "local" } }] });
  });
  return listen(server).then((port) => ({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() }));
}

(async () => {
  const g = await fakeGateway();
  const or = await fakeOpenRouter();
  const local = await fakeLocal();
  const candidates = [{ id: "ollama-local", alias: "ollama", name: "Ollama", url: local.url }, { id: "lm-studio", alias: "lmstudio", name: "LM Studio", url: "http://127.0.0.1:9/v1" }];

  // ── status before anything ──
  let st = await providers.status(g.gw, { candidates });
  check("status lists the catalog, no provider connected", st.providers.length === providers.CATALOG.length && !st.providers.some((p) => p.connected));
  check("status reports the OpenCode engine and its free models", st.opencode && st.opencode.installed && st.opencode.models.includes("opencode/nemotron-3.5-lightning-free"));
  check("status sees the free pool but an empty chain", st.freePool === 2 && st.chain.length === 0);
  check("status detects the running local server", st.local.find((l) => l.id === "ollama-local").running && !st.local.find((l) => l.id === "lm-studio").running);
  check("describe() tells the user nothing is connected", /No free provider connected/.test(providers.describe(st)));

  // ── key connect: good key ──
  const groq = await providers.connectWithKey(g.gw, "groq", "gsk-good");
  check("a pasted key creates the connection", g.conns.some((c) => c.provider === "groq" && c.apiKey === "gsk-good"));
  check("…and reports the models it exposes", groq.models === 2);
  check("…after verifying the key with one request on the preferred model", g.chats.includes("groq/openai/gpt-oss-120b"));
  check("…and the chain now leads with it", JSON.stringify(groq.chain) === JSON.stringify(["groq/openai/gpt-oss-120b"]));

  // ── key connect: rejected key is not kept ──
  let rejected = null;
  try { await providers.connectWithKey(g.gw, "gemini", "bad-key"); } catch (e) { rejected = e.message; }
  check("a rejected key throws with the provider's key page", rejected && /rejected that key/.test(rejected) && /aistudio/.test(rejected));
  check("…and leaves no dead connection behind", !g.conns.some((c) => c.provider === "gemini"));

  // ── re-pasting replaces instead of duplicating ──
  await providers.connectWithKey(g.gw, "groq", "gsk-better");
  check("re-connecting a provider replaces the old connection", g.conns.filter((c) => c.provider === "groq").length === 1 && g.conns.find((c) => c.provider === "groq").apiKey === "gsk-better");

  // ── a bad re-paste keeps the working connection ──
  let badAgain = null;
  try { await providers.connectWithKey(g.gw, "groq", "bad-key"); } catch (e) { badAgain = e.message; }
  check("a rejected replacement key leaves the previous working key in place, active", badAgain && /Nothing was changed/.test(badAgain) && g.conns.filter((c) => c.provider === "groq").length === 1 && g.conns.find((c) => c.provider === "groq").apiKey === "gsk-better" && g.conns.find((c) => c.provider === "groq").isActive !== false);

  // ── unknown provider / empty key ──
  let bad = null; try { await providers.connectWithKey(g.gw, "nope", "x"); } catch (e) { bad = e.message; }
  check("unknown providers are refused with the known list", bad && /unknown provider/.test(bad) && /openrouter/.test(bad));
  let empty = null; try { await providers.connectWithKey(g.gw, "cerebras", "  "); } catch (e) { empty = e.message; }
  check("an empty key points at where to get one", empty && /cloud\.cerebras\.ai/.test(empty));

  // ── PKCE ──
  let seenUrl = null;
  // "Opening the browser" here means hitting the fake /auth page, which plays the signed-in user and calls our loopback back.
  const orRes = await providers.connectOpenRouter(g.gw, { authBase: or.base, open: (u) => { fetch(u).catch(() => {}); }, onUrl: (u) => { seenUrl = u; } });
  check("PKCE opens an /auth URL with a nonce-bearing loopback callback and an S256 challenge", seenUrl && /\/auth\?callback_url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback%2F[A-Za-z0-9_-]{16,}&code_challenge=[A-Za-z0-9_-]{40,}&code_challenge_method=S256/.test(seenUrl));
  check("…exchanges the code for a key and stores it", g.conns.some((c) => c.provider === "openrouter" && c.apiKey === "sk-or-v1-from-pkce"));
  check("…and reports OpenRouter's models", orRes.provider === "openrouter" && orRes.models === 4);

  // ── chain ordering: catalog order, preferred model first, pattern fallback ──
  st = await providers.status(g.gw, { candidates, detectLocal: false });
  check("the chain prefers the coder on OpenRouter and keeps catalog order", JSON.stringify(st.chain) === JSON.stringify(["openrouter/cohere/north-mini-code:free", "groq/openai/gpt-oss-120b"]));
  const noPref = providers.suggestChain(["openrouter/x/y:free", "openrouter/openai/gpt-5", "groq/other-model"]);
  check("without a preferred id it falls back to the :free pattern, then the first listed", JSON.stringify(noPref) === JSON.stringify(["openrouter/x/y:free", "groq/other-model"]));
  check("the chain is capped", providers.suggestChain(["openrouter/a:free", "ollamacloud/b", "kg/c", "groq/d", "cerebras/e", "nvidia/f", "gemini/g", "mistral/h"]).length === 6);

  // ── local ──
  const loc = await providers.connectLocal(g.gw, { candidates });
  check("connectLocal registers the running server with its base URL", loc.added.length === 1 && g.conns.some((c) => c.provider === "ollama-local" && c.providerSpecificData && c.providerSpecificData.baseUrl === local.url));
  check("…skips the ones not running", loc.skipped.length === 1 && loc.skipped[0].id === "lm-studio");
  check("…and local closes the chain", loc.chain[loc.chain.length - 1] === "ollama/qwen2.5-coder:7b");

  // ── connect() dispatch + remove ──
  const viaConnect = await providers.connect(g.gw, "local");
  check("connect('local') dispatches to local detection", viaConnect.added !== undefined);
  const removed = await providers.removeProvider(g.gw, "groq");
  check("removeProvider deletes every connection for the provider", removed === 1 && !g.conns.some((c) => c.provider === "groq"));

  g.close(); or.close(); local.close();
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ PROVIDERS TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e); process.exit(1); });
