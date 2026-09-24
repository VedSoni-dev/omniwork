"use strict";
const opencode = require("./opencode-engine");
const { LOCAL } = require("./providers");
const health = new Map();

function gatewayModel(m) {
  const id = m.id;
  const provider = id.split("/")[0];
  const price = m.pricing || m.cost;
  const input = price?.prompt ?? price?.input;
  const output = price?.completion ?? price?.output;
  const zero = input != null && output != null && Number(input) === 0 && Number(output) === 0;
  const local = LOCAL.some(p => p.alias === provider);
  const free = local || zero || /:free$|\/free$|-free$/.test(id);
  return {
    id, name: m.name || id, provider, source: "gateway", free,
    pricing: free ? "free" : price ? "paid" : "unknown",
    access: local ? "local" : "gateway account or public route",
    tools: m.supported_parameters ? m.supported_parameters.includes("tools") : m.tool_call ?? m.supports_tools ?? null,
    context: m.context_length || m.max_input_tokens || m.limit?.context || null,
    health: "untested", // A catalog entry is not a successful completion.
  };
}

async function catalog(gw, { force = false } = {}) {
  const errors = [], models = [];
  await Promise.all([
    (async () => {
      if (!gw) return;
      try {
        const res = await fetch(`${gw.baseUrl}/models`, { headers: { Authorization: `Bearer ${gw.apiKey || "omniwork"}` }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const m of (await res.json()).data || []) if (typeof m.id === "string") models.push(gatewayModel(m));
      } catch (e) { errors.push({ source: "gateway", message: e.message }); }
    })(),
    (async () => {
      if (!opencode.available()) return;
      try {
        for (const m of await opencode.getEngine().models({ force })) models.push({ ...m, provider: m.providerID, source: "OpenCode", pricing: m.free ? "free" : m.cost ? "paid" : "unknown", health: "untested" });
      } catch (e) { errors.push({ source: "OpenCode", message: e.message }); }
    })(),
  ]);
  return { models: [...new Map(models.map(m => [m.id, { ...m, ...(health.get(m.id) || {}) }])).values()].sort((a,b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id)), errors };
}

// Explicit user action only. Sends a small synthetic prompt, never workspace
// content. An advertised model is not marked healthy until it actually answers.
async function probe(gw, id, { timeoutMs = 20_000 } = {}) {
  if (typeof id !== "string" || !id.trim()) throw new Error("model is required");
  const started = Date.now();
  let result;
  try {
    let text;
    if (opencode.isEngineModel(id)) {
      const engine = opencode.getEngine();
      const models = await engine.models();
      const model = models.find(m => m.id === id);
      if (!model) throw new Error("Model is not in the connected engine catalog");
      const directory = require("node:os").tmpdir();
      const sid = await engine.createSession({ directory, title: "OmniWork model check", permission: [{ permission: "*", pattern: "*", action: "deny" }] });
      try {
        const response = await engine.prompt(sid, { directory, providerID: model.providerID, modelID: model.modelID, text: "Reply with exactly READY. Do not use tools.", signal: AbortSignal.timeout(timeoutMs) });
        if (response?.info?.error) {
          const error = new Error(response.info.error.data?.message || response.info.error.name);
          error.status = response.info.error.data?.statusCode;
          throw error;
        }
        text = (response?.parts || []).filter(p => p.type === "text").map(p => p.text).join("");
      } finally { await engine.abort(sid, directory); }
    } else {
      if (!gw) throw new Error("Gateway is unavailable");
      const response = await fetch(`${gw.baseUrl}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.apiKey || "omniwork"}` },
        body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Reply with exactly READY." }], max_tokens: 16, stream: false }), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) { const e = new Error(`HTTP ${response.status}`); e.status = response.status; throw e; }
      text = (await response.json()).choices?.[0]?.message?.content;
    }
    if (!String(text || "").trim()) throw new Error("Empty response");
    result = { health: "responding", checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, detail: "Answered a text-only readiness request; tool execution is not tested." };
  } catch (e) {
    result = { health: e.status === 429 ? "rate limited" : /timeout|abort/i.test(e.name + e.message) ? "timed out" : "check failed", checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, detail: e.message + (opencode.isEngineModel(id) && e.status === 403 ? " (This restricted readiness check was rejected; a normal engine task may behave differently.)" : "") };
  }
  health.set(id, result);
  return { model: id, ...result };
}

function filterModels(models, { query = "", free_only = false, tools_only = false } = {}) {
  const q = String(query).toLowerCase();
  return models.filter(m => (!free_only || m.free) && (!tools_only || m.tools === true) && `${m.id} ${m.name} ${m.provider}`.toLowerCase().includes(q));
}

module.exports = { catalog, gatewayModel, filterModels, probe };
