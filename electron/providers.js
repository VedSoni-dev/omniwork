"use strict";
// Free-model providers for the gateway: what to connect, how to connect it in
// as few clicks as possible, and which connected models a headless agent
// should fall back to.
//
// Why this exists: OmniRoute's out-of-the-box "free" pool is a handful of
// unofficial keyless endpoints (a scraped hobby site, a restaurant's chat
// widget, a CLI shim) that vanish without notice — on a bad day every one is
// gone and `auto` has nothing left to route. The providers here are the
// opposite: real free tiers with published limits, behind a free account key.
// OmniRoute already speaks to all of them; this module gets the key in with
// one click (OpenRouter through its PKCE flow, the rest by paste), registers
// local model servers it finds running, and turns "what's connected" into the
// fallback chain the ACP/MCP servers and the desktop app use.

const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");
const opencode = require("./opencode-engine");

// Ordered by how good a fallback each is: strongest free coders first, the
// widest catalogs before the narrow ones. `prefer` lists model ids (without
// the gateway's alias prefix) in the order we'd pick them for a coding agent.
const CATALOG = [
  {
    id: "openrouter", alias: "openrouter", name: "OpenRouter", connect: "pkce",
    keyUrl: "https://openrouter.ai/settings/keys",
    free: "20 free models (18 with tool calling) — 20 req/min, 50 req/day; 1,000/day after a one-time $10 top-up",
    prefer: ["cohere/north-mini-code:free", "nvidia/nemotron-3-super-120b-a12b:free", "google/gemma-4-31b-it:free", "nvidia/nemotron-3.5-lightning:free"],
    preferPattern: /:free$/,
  },
  {
    id: "ollama-cloud", alias: "ollamacloud", name: "Ollama Cloud", connect: "key",
    keyUrl: "https://ollama.com/settings/keys",
    free: "free 'light usage' tier — DeepSeek V4, Kimi K2.6, GLM 5.1, Gemma 4 (sign in, no card)",
    prefer: ["deepseek-v4-flash", "glm-5.1", "gemma4:31b", "kimi-k2.6"],
  },
  {
    id: "kilo-gateway", alias: "kg", name: "Kilo Gateway", connect: "key",
    keyUrl: "https://app.kilo.ai",
    free: "kilo-auto/free router plus Nemotron 3 Super and MiniMax M2.5 :free (free account)",
    prefer: ["kilo-auto/free", "nvidia/nemotron-3-super-120b-a12b:free", "minimax/minimax-m2.5:free"],
  },
  {
    id: "groq", alias: "groq", name: "Groq", connect: "key",
    keyUrl: "https://console.groq.com/keys",
    free: "gpt-oss-120b at 30 req/min, 1,000 req/day; Qwen 3 32B, Llama 3.3 70B — very fast",
    prefer: ["openai/gpt-oss-120b", "qwen/qwen3-32b", "llama-3.3-70b-versatile"],
  },
  {
    id: "cerebras", alias: "cerebras", name: "Cerebras", connect: "key",
    keyUrl: "https://cloud.cerebras.ai",
    free: "free tier on gpt-oss-120b, GLM 4.7, Gemma 4 — fastest inference around",
    prefer: ["gpt-oss-120b", "zai-glm-4.7", "gemma-4-31b"],
  },
  {
    id: "nvidia", alias: "nvidia", name: "NVIDIA NIM", connect: "key",
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    free: "developer tier, ~40 req/min — Qwen 3.5, GLM 5.2, Gemma 4",
    prefer: ["qwen/qwen3.5-122b-a10b", "z-ai/glm-5.2", "google/gemma-4-31b-it"],
  },
  {
    id: "gemini", alias: "gemini", name: "Google Gemini", connect: "key",
    keyUrl: "https://aistudio.google.com/apikey",
    free: "Gemini Flash and Flash-Lite free tier (Google account, no card)",
    prefer: ["gemini-2.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash-lite"],
  },
  {
    id: "mistral", alias: "mistral", name: "Mistral", connect: "key",
    keyUrl: "https://console.mistral.ai/api-keys",
    free: "free tier incl. Codestral (phone verification)",
    prefer: ["codestral-latest"],
  },
];

// Local OpenAI-compatible servers, probed on their default ports. Slower and
// smaller than the cloud tiers, so they sit at the end of the chain — but a
// local model is the only thing that is *always* there.
const LOCAL = [
  { id: "ollama-local", alias: "ollama", name: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { id: "lm-studio", alias: "lmstudio", name: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  { id: "llama-cpp", alias: "llamacpp", name: "llama.cpp", url: "http://127.0.0.1:8080/v1" },
  { id: "vllm", alias: "vllm", name: "vLLM", url: "http://127.0.0.1:8000/v1" },
];

const MAX_CHAIN = 6;

// ── gateway management API ────────────────────────────────────────
// OmniRoute's dashboard API, served openly on loopback. `gw.baseUrl` is the
// OpenAI-compatible `/v1` URL the agents use; the management API lives beside it.
function origin(gw) { return String(gw.baseUrl).replace(/\/v1\/?$/, ""); }

async function call(gw, method, path, body, timeoutMs = 10_000) {
  const res = await fetch(origin(gw) + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.apiKey || "omniwork"}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = (json && json.error && (json.error.message || json.error)) || text.slice(0, 200) || `HTTP ${res.status}`;
    const err = new Error(`gateway ${method} ${path}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function connections(gw) {
  const data = await call(gw, "GET", "/api/providers");
  return (data && data.connections) || [];
}

async function modelIds(gw) {
  const data = await call(gw, "GET", "/v1/models", null, 8000);
  return ((data && data.data) || []).map((m) => m && m.id).filter((id) => typeof id === "string" && id);
}

// One connection per provider+name: adding again replaces, so a re-pasted key
// never leaves a dead twin behind that the pool keeps trying.
async function addConnection(gw, { provider, name, apiKey, baseUrl }) {
  const existing = (await connections(gw)).filter((c) => c.provider === provider && c.name === name);
  for (const c of existing) await call(gw, "DELETE", `/api/providers/${c.id}`).catch(() => {});
  const body = { provider, authType: "apikey", name, apiKey };
  if (baseUrl) body.providerSpecificData = { baseUrl };
  const data = await call(gw, "POST", "/api/providers", body);
  return data && data.connection;
}

// The gateway discovers a passthrough provider's models asynchronously after
// the connection lands — a few seconds for a local server. Anyone computing
// "what's routable now" right after a connect has to wait for that.
async function waitForModels(gw, alias, { timeoutMs = 12_000 } = {}) {
  const until = Date.now() + timeoutMs;
  let ids = [];
  while (Date.now() < until) {
    ids = await modelIds(gw).catch(() => []);
    if (ids.some((id) => id.startsWith(alias + "/"))) return ids;
    await new Promise((r) => setTimeout(r, 500));
  }
  return ids;
}

async function removeProvider(gw, provider) {
  const mine = (await connections(gw)).filter((c) => c.provider === provider);
  for (const c of mine) await call(gw, "DELETE", `/api/providers/${c.id}`);
  return mine.length;
}

// ── what's connected, what to fall back to ────────────────────────
function entry(id) { return CATALOG.find((p) => p.id === id) || LOCAL.find((l) => l.id === id) || null; }

function modelsFor(p, ids) {
  const prefix = p.alias + "/";
  return ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
}

// The fallback chain: for each connected provider, in catalog order, the best
// model it exposes right now — the preferred ids first, then anything the
// provider's free pattern matches, then whatever it lists. Local servers
// close the chain. Capped so a turn that hits every failure still ends.
function suggestChain(ids, { max = MAX_CHAIN } = {}) {
  const chain = [];
  for (const p of [...CATALOG, ...LOCAL]) {
    const have = modelsFor(p, ids);
    if (!have.length) continue;
    const pick = (p.prefer || []).find((m) => have.includes(m))
      || (p.preferPattern ? have.find((m) => p.preferPattern.test(m)) : null)
      || have[0];
    chain.push(`${p.alias}/${pick}`);
    if (chain.length >= max) break;
  }
  return chain;
}

async function probeLocal(url, timeoutMs = 1500) {
  try {
    const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return ((data && data.data) || []).map((m) => m && m.id).filter(Boolean);
  } catch { return null; }
}

async function status(gw, { detectLocal = true, candidates = LOCAL } = {}) {
  const [conns, ids] = await Promise.all([connections(gw), modelIds(gw)]);
  const connected = (id) => conns.some((c) => c.provider === id && c.isActive !== false);
  const providers = CATALOG.map((p) => ({
    id: p.id, name: p.name, connect: p.connect, keyUrl: p.keyUrl, free: p.free,
    connected: connected(p.id), models: modelsFor(p, ids).length,
  }));
  const local = [];
  for (const l of candidates) {
    const running = detectLocal ? await probeLocal(l.url) : null;
    local.push({ id: l.id, name: l.name, url: l.url, connected: connected(l.id), running: running != null, runningModels: running || [], models: modelsFor(l, ids).length });
  }
  // The OpenCode engine: free Zen models with no account, if OpenCode is
  // installed. Listing them starts its server once per process.
  const oc = { installed: opencode.available(), version: null, models: [], installCommand: opencode.INSTALL_COMMAND, installScript: opencode.INSTALL_SCRIPT };
  if (oc.installed) {
    oc.version = opencode.version();
    try { oc.models = (await opencode.getEngine().models()).map((m) => m.id); } catch (e) { oc.error = e.message; }
  }
  return {
    providers, local, opencode: oc,
    chain: suggestChain(ids),
    freePool: ids.filter((id) => id === "auto" || id.startsWith("auto/")).length,
    anyConnected: providers.some((p) => p.connected) || local.some((l) => l.connected) || oc.models.length > 0,
  };
}

// ── connecting ────────────────────────────────────────────────────
// A key that the provider rejects is worse than no key: the pool would keep
// trying it. So a pasted key is exercised once before it's kept.
async function verifyModel(gw, modelId) {
  const res = await fetch(`${gw.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.apiKey || "omniwork"}` },
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Reply with the single word READY." }], max_tokens: 8 }),
    signal: AbortSignal.timeout(45_000),
  });
  if (res.ok) return true;
  const body = await res.text().catch(() => "");
  const err = new Error(`${modelId} answered HTTP ${res.status}: ${body.slice(0, 200)}`);
  err.status = res.status;
  throw err;
}

async function connectWithKey(gw, providerId, apiKey, { verify = true } = {}) {
  const p = CATALOG.find((c) => c.id === providerId);
  if (!p) throw new Error(`unknown provider: ${providerId} (known: ${CATALOG.map((c) => c.id).join(", ")})`);
  const key = String(apiKey || "").trim();
  if (!key) throw new Error(`${p.name} needs an API key — create one at ${p.keyUrl}`);
  const conn = await addConnection(gw, { provider: p.id, name: p.name, apiKey: key });
  const ids = await waitForModels(gw, p.alias);
  const have = modelsFor(p, ids);
  const model = (p.prefer || []).find((m) => have.includes(m)) || (p.preferPattern ? have.find((m) => p.preferPattern.test(m)) : null) || have[0];
  if (verify && model) {
    try { await verifyModel(gw, `${p.alias}/${model}`); }
    catch (e) {
      // 401/403 is the key itself; anything else (quota, a flaky model) is
      // not a reason to throw the key away.
      if (e.status === 401 || e.status === 403) {
        if (conn && conn.id) await call(gw, "DELETE", `/api/providers/${conn.id}`).catch(() => {});
        throw new Error(`${p.name} rejected that key (${e.message}). Check it at ${p.keyUrl}.`);
      }
    }
  }
  return { provider: p.id, name: p.name, models: have.length, chain: suggestChain(ids) };
}

async function connectLocal(gw, { candidates = LOCAL, only = null } = {}) {
  const added = [];
  const skipped = [];
  for (const l of candidates) {
    if (only && l.id !== only) continue;
    const running = await probeLocal(l.url);
    if (!running) { skipped.push({ id: l.id, name: l.name, reason: "not running" }); continue; }
    await addConnection(gw, { provider: l.id, name: l.name, apiKey: "local", baseUrl: l.url });
    added.push({ id: l.id, name: l.name, url: l.url, models: running });
  }
  const ids = added.length ? await waitForModels(gw, added[added.length - 1].alias || entry(added[added.length - 1].id).alias) : await modelIds(gw);
  return { added, skipped, chain: suggestChain(ids) };
}

// OpenRouter's PKCE flow: the browser creates a key for us — no dashboard,
// no copy-paste. A loopback server catches the redirect; the code is only
// useful together with our verifier, so a stray callback can't mint a key.
function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

function defaultOpen(url) {
  const cmd = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); return true; }
  catch { return false; }
}

const DONE_PAGE = (ok) => `<!doctype html><meta charset="utf-8"><title>OmniWork</title>
<body style="font:15px/1.5 -apple-system,system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:40px">${ok ? "✅" : "❌"}</div>
<p>${ok ? "OpenRouter is connected to OmniWork. You can close this tab." : "OpenRouter did not return a code. Close this tab and try again."}</p></div>`;

async function connectOpenRouter(gw, { open = defaultOpen, onUrl = () => {}, authBase = "https://openrouter.ai", timeoutMs = 300_000, label = "OmniWork" } = {}) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const callback = `http://127.0.0.1:${port}/callback`;
  const url = `${authBase}/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256&key_label=${encodeURIComponent(label)}`;

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for the OpenRouter sign-in (5 min)")), timeoutMs);
      server.on("request", (req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
        const c = u.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE(Boolean(c)));
        clearTimeout(timer);
        if (c) resolve(c); else reject(new Error("OpenRouter returned no code"));
      });
      onUrl(url);
      open(url);
    });
  } finally {
    server.close();
  }

  const res = await fetch(`${authBase}/api/v1/auth/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenRouter key exchange failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = await res.json();
  if (!data || !data.key) throw new Error("OpenRouter key exchange returned no key");
  return await connectWithKey(gw, "openrouter", data.key, { verify: false });
}

// One entry point for every surface (CLI, MCP tool, ACP auth method, desktop).
async function connect(gw, providerId, { apiKey, open, onUrl, authBase, install = false, log } = {}) {
  if (providerId === "opencode") {
    if (!opencode.available()) {
      if (!install) throw new Error(`OpenCode is not present yet — run: ${opencode.INSTALL_COMMAND}  (downloads ~45 MB; or: ${opencode.INSTALL_SCRIPT})`);
      await opencode.install({ log });
    }
    const models = await opencode.getEngine().models({ force: true });
    return { provider: "opencode", name: "OpenCode engine", engine: true, version: opencode.version(), models: models.length, modelIds: models.map((m) => m.id), chain: suggestChain(await modelIds(gw)) };
  }
  if (providerId === "local") return await connectLocal(gw);
  if (LOCAL.some((l) => l.id === providerId)) return await connectLocal(gw, { only: providerId });
  if (providerId === "openrouter" && !apiKey) return await connectOpenRouter(gw, { open, onUrl, authBase });
  return await connectWithKey(gw, providerId, apiKey);
}

// Human-readable status, shared by the CLI and the MCP tool.
function describe(st) {
  const lines = [];
  const on = [...st.providers.filter((p) => p.connected), ...st.local.filter((l) => l.connected)];
  lines.push(on.length
    ? `Connected: ${on.map((p) => `${p.name} (${p.models} models)`).join(", ")}.`
    : "No free provider connected yet — the gateway's built-in keyless pool is unreliable (its endpoints get shut off upstream), so connect at least one.");
  lines.push(st.chain.length ? `Fallback chain: ${st.chain.join(" → ")}` : "Fallback chain: (empty — nothing connected)");
  lines.push("");
  lines.push("Free providers (free account, no card):");
  for (const p of st.providers) {
    lines.push(`- ${p.connected ? "✓" : "○"} ${p.id} — ${p.name}: ${p.free}. ${p.connect === "pkce" ? "Connect: one click, no key to paste." : `Key: ${p.keyUrl}`}`);
  }
  const oc = st.opencode;
  if (oc) {
    lines.push("");
    lines.push(oc.installed
      ? `OpenCode engine: installed (${oc.version || "?"}) — ${oc.models.length ? `free models, no account: ${oc.models.join(", ")}` : (oc.error ? `could not list models: ${oc.error}` : "no free models listed")}. Runs OpenCode's own server; the automatic fallback when nothing else answers.`
      : `OpenCode engine: not present yet. ${oc.installCommand} downloads OpenCode's official release (~45 MB, no npm, no PATH) and adds Zen's free models (Nemotron 3.5 Lightning, MiMo V2.5, Big Pickle, Ling 3.0 Flash, Nemotron 3 Ultra) with no account at all.`);
  }
  const running = st.local.filter((l) => l.running);
  lines.push("");
  lines.push(running.length
    ? `Local model servers running: ${running.map((l) => `${l.name}${l.connected ? " (connected)" : ` — ${l.runningModels.length} models, not connected yet`}`).join("; ")}`
    : "Local model servers: none running (Ollama on :11434, LM Studio on :1234, llama.cpp on :8080, vLLM on :8000 are auto-detected).");
  return lines.join("\n");
}

module.exports = { CATALOG, LOCAL, status, describe, connect, connectWithKey, connectOpenRouter, connectLocal, removeProvider, suggestChain, connections, modelIds, waitForModels, defaultOpen };
