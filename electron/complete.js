"use strict";
// Tool-free completion: one request in, one completion out.
//
// For text that must not be able to act — founder decks, scraped pages, any
// untrusted document — a model with no tools is the only defense that does
// not depend on the model behaving. So this path, shared by the ACP
// `completion` mode, the MCP `complete` tool and `npm run complete`:
//   - never sends `tools` or `tool_choice`;
//   - uses the caller's system prompt verbatim — no OmniWork prompt, no
//     project files, memory or skills;
//   - reads no workspace and writes nothing (no transcript, no log);
//   - with a JSON Schema, asks for structured output, validates the reply and
//     retries once with the errors — never turning bad JSON into `{}`.
//
// Local models go straight to their server instead of through the gateway:
// `ollama/<model>` uses Ollama's native /api/chat, the only way to set the
// context length (Ollama's default can be 4096 tokens, and a longer prompt is
// silently cut from the start — the system prompt and schema first) and to
// see how much of the prompt it actually read.

const { validate, describe } = require("./json-schema");
const providers = require("./providers");

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120_000;
const CONTEXT_BUCKETS = [8192, 16384, 32768, 65536, 131072, 262144];

class CompletionError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

// ── prompt pieces ──────────────────────────────────────────────────
const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n") : "";

function schemaInstruction(schema) {
  return `\n\n---\nRespond with only a JSON value that conforms to this JSON Schema — no prose, no code fences:\n${JSON.stringify(schema)}`;
}

// The user turn, with the schema instruction after the content: the last word
// is the caller's, not the document's.
function userContent(user, schema, inPrompt) {
  const extra = schema && inPrompt ? schemaInstruction(schema) : "";
  if (typeof user === "string") return user + extra;
  const parts = Array.isArray(user) ? user.slice() : [{ type: "text", text: String(user ?? "") }];
  if (extra) parts.push({ type: "text", text: extra.trimStart() });
  return parts;
}

// Reasoning models sometimes put their thinking in the content.
const stripThinking = (t) => String(t || "").replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "").trim();

// The first JSON value in a reply: the whole reply, a fenced block, or the
// first balanced object/array. Null when there is none.
function extractJson(text) {
  const t = stripThinking(text);
  const attempt = (s) => { try { return { value: JSON.parse(s) }; } catch { return null; } };
  const whole = attempt(t);
  if (whole) return whole;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { const f = attempt(fence[1].trim()); if (f) return f; }
  for (let start = t.search(/[{[]/); start >= 0;) {
    const end = matchingBracket(t, start);
    if (end > start) { const b = attempt(t.slice(start, end + 1)); if (b) return b; }
    const next = t.slice(start + 1).search(/[{[]/);
    start = next >= 0 ? start + 1 + next : -1;
  }
  return null;
}

function matchingBracket(s, start) {
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === "\"") inString = false; continue; }
    if (c === "\"") inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

// Conservative: more tokens than most tokenizers produce, so a context sized
// from it has room, and "it can't fit" is not claimed lightly.
const highTokens = (chars) => Math.ceil(chars / 3);

// ── routing ────────────────────────────────────────────────────────
// `<alias>/<model>` for a local server goes to that server directly.
function routeFor(model) {
  const slash = model.indexOf("/");
  const alias = slash > 0 ? model.slice(0, slash) : "";
  const local = providers.LOCAL.find((l) => l.alias === alias);
  if (!local) return { transport: "gateway", model };
  const url = providers.localUrl(local);
  return local.id === "ollama-local"
    ? { transport: "ollama", model: model.slice(slash + 1), base: url.replace(/\/v1\/?$/, ""), name: local.name }
    : { transport: "local", model: model.slice(slash + 1), base: url, name: local.name };
}

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function readError(res) {
  const body = await res.text().catch(() => "");
  try { const j = JSON.parse(body); return typeof j.error === "string" ? j.error : j.error?.message || j.message || body.slice(0, 300); }
  catch { return body.slice(0, 300); }
}

// ── OpenAI-compatible: the gateway, LM Studio, llama.cpp, vLLM ─────
async function openAiRequest({ url, apiKey, model, messages, schema, schemaName, temperature, maxTokens, signal, responseFormat }) {
  const body = {
    model, messages, temperature, max_tokens: maxTokens, stream: false,
    ...(schema && responseFormat ? { response_format: { type: "json_schema", json_schema: { name: schemaName, schema } } } : {}),
  };
  const res = await fetch(`${url}/chat/completions`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new CompletionError(`HTTP ${res.status}: ${await readError(res)}`, { status: res.status });
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) throw new CompletionError("No choices returned");
  // Nothing offered tools, so a tool call means something in between added
  // them. Fail rather than hand back a reply that wanted to act.
  if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length) throw new CompletionError("The model returned a tool call, but this completion offers no tools — reply discarded");
  const content = typeof choice.message.content === "string" ? choice.message.content : textOf(choice.message.content);
  return { text: content, finishReason: choice.finish_reason || null, usage: data.usage ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens } : null, served: data.model || null };
}

// ── Ollama, natively ───────────────────────────────────────────────
const showCache = new Map(); // `${base} ${model}` -> { contextLength, thinking }

async function ollamaShow(base, model, signal) {
  const k = `${base} ${model}`;
  if (showCache.has(k)) return showCache.get(k);
  const res = await fetch(`${base}/api/show`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
  if (res.status === 404) throw new CompletionError(`Ollama has no model "${model}" — run: ollama pull ${model}`, { status: 404 });
  if (!res.ok) throw new CompletionError(`Ollama /api/show HTTP ${res.status}: ${await readError(res)}`, { status: res.status });
  const data = await res.json();
  const info = data.model_info || {};
  const arch = info["general.architecture"];
  const contextLength = Number(info[`${arch}.context_length`]) || Number(Object.entries(info).find(([key]) => /\.context_length$/.test(key))?.[1]) || null;
  const out = { contextLength, thinking: Array.isArray(data.capabilities) && data.capabilities.includes("thinking") };
  showCache.set(k, out);
  return out;
}

// The context to load: room for the prompt (counted high) and the reply,
// rounded up to a bucket — Ollama reloads a model whenever num_ctx changes, so
// a batch of similar documents shares one size — and capped at what the model
// supports.
function contextFor(promptChars, maxTokens, modelMax, requested) {
  const need = highTokens(promptChars) + maxTokens + 256;
  let n = requested || CONTEXT_BUCKETS.find((b) => b >= need) || CONTEXT_BUCKETS[CONTEXT_BUCKETS.length - 1];
  if (modelMax) n = Math.min(n, modelMax);
  return { numCtx: n, fits: need <= n };
}

function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const images = (m.content || []).filter((p) => p && p.type === "image_url").map((p) => String(p.image_url?.url || "").replace(/^data:[^;]+;base64,/, ""));
    return { role: m.role, content: textOf(m.content), ...(images.length ? { images } : {}) };
  });
}

async function ollamaRequest({ base, model, messages, schema, temperature, maxTokens, numCtx: requested, signal, schemaFormat, promptChars }) {
  let show;
  try { show = await ollamaShow(base, model, signal); }
  catch (e) {
    if (e instanceof CompletionError) throw e;
    throw new CompletionError(`Ollama is not answering at ${base} (${e.cause?.code || e.message}). Start it with \`ollama serve\`, or set OLLAMA_HOST if it listens elsewhere.`, { transportDown: true });
  }
  const { numCtx, fits } = contextFor(promptChars, maxTokens, show.contextLength, requested);
  const body = {
    model, messages: toOllamaMessages(messages), stream: false,
    options: { temperature, num_ctx: numCtx, num_predict: maxTokens },
    ...(schema ? { format: schemaFormat === "json" ? "json" : schema } : {}),
    // Thinking models reason before answering; for structured output that
    // only costs time and context. Sent only where the model supports it.
    ...(show.thinking ? { think: false } : {}),
  };
  const res = await fetch(`${base}/api/chat`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new CompletionError(`Ollama HTTP ${res.status}: ${await readError(res)}`, { status: res.status });
  const data = await res.json();
  const evalCount = Number(data.prompt_eval_count) || 0;
  // Cut to fit: the prompt we sent could not fit, or it filled the context.
  // (Prompt caching only ever lowers the count, so it can't fake this.)
  const truncated = !fits || evalCount >= numCtx - 32;
  return {
    text: data.message?.content || "", finishReason: data.done_reason || null, numCtx, truncated,
    usage: { prompt_tokens: evalCount || null, completion_tokens: Number(data.eval_count) || null, prompt_eval_count: evalCount || null, eval_count: Number(data.eval_count) || null },
  };
}

// ── the public entry point ────────────────────────────────────────
// gateway: { baseUrl, apiKey } or an async function returning one — only
// called if a model needs the gateway.
async function complete({
  system = "", user, model = "auto", fallbackModels = [], schema = null, schemaName = "result",
  temperature = 0.2, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS, numCtx = null,
  gateway = null, signal = null, schemaInPrompt = true,
} = {}) {
  if (user == null || (typeof user === "string" && !user.trim() && !String(system || "").trim())) throw new CompletionError("user content is required");
  if (typeof system !== "string") throw new CompletionError("system must be a string");
  if (schema != null && (typeof schema !== "object" || Array.isArray(schema))) throw new CompletionError("schema must be a JSON Schema object");
  const chain = [model, ...(fallbackModels || []).filter((m) => m && m !== model)].map(String);
  if (chain.some((m) => /^opencode\//.test(m))) throw new CompletionError("OpenCode engine models run as agents with their own tools and prompt, so they can't serve a tool-free completion — pick a gateway or local model");

  const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: userContent(user, schema, schemaInPrompt) }];
  const promptChars = messages.reduce((n, m) => n + textOf(m.content).length, 0);
  const attempts = [];
  let gw = null;
  const gatewayInfo = async () => (gw ||= typeof gateway === "function" ? await gateway() : gateway);
  let last = null;

  for (const id of chain) {
    const route = routeFor(id);
    const started = Date.now();
    const call = async (msgs, opts = {}) => {
      const sig = withTimeout(signal, timeoutMs);
      if (route.transport === "ollama") return await ollamaRequest({ base: route.base, model: route.model, messages: msgs, schema, temperature, maxTokens, numCtx, signal: sig, schemaFormat: opts.schemaFormat, promptChars });
      const target = route.transport === "local" ? { url: route.base, apiKey: null } : await gatewayInfo().then((g) => {
        if (!g || !g.baseUrl) throw new CompletionError("No gateway is available for this model");
        return { url: g.baseUrl.replace(/\/$/, ""), apiKey: g.apiKey };
      });
      const r = await openAiRequest({ ...target, model: route.transport === "local" ? route.model : id, messages: msgs, schema, schemaName, temperature, maxTokens, signal: sig, responseFormat: opts.responseFormat !== false });
      const approx = highTokens(promptChars) / 4; // a floor far below any real tokenizer
      return { ...r, truncated: Boolean(r.usage && r.usage.prompt_tokens && r.usage.prompt_tokens < approx) };
    };

    let reply;
    try {
      try { reply = await call(messages); }
      catch (e) {
        // A backend that rejects structured-output parameters still gets the
        // schema through the prompt, and the reply is validated either way.
        if (!schema || ![400, 422].includes(e.status) || !/response_format|json_schema|format|schema/i.test(e.message)) throw e;
        attempts.push({ model: id, transport: route.transport, ok: false, status: e.status, error: e.message, retry: "without structured-output parameters", ms: Date.now() - started });
        reply = await call(messages, { responseFormat: false, schemaFormat: "json" });
      }
    } catch (e) {
      if (signal?.aborted) throw new CompletionError("Cancelled", { cancelled: true, attempts });
      const timedOut = e.name === "TimeoutError" || /aborted|timeout/i.test(e.message);
      attempts.push({ model: id, transport: route.transport, ok: false, status: e.status || null, error: timedOut ? `timed out after ${timeoutMs} ms` : e.message, ms: Date.now() - started });
      last = { error: timedOut ? `timed out after ${timeoutMs} ms` : e.message };
      continue;
    }

    let text = stripThinking(reply.text);
    let result = { text, finishReason: reply.finishReason, usage: reply.usage, truncated: reply.truncated, numCtx: reply.numCtx };
    if (!schema) {
      if (!text) { attempts.push({ model: id, transport: route.transport, ok: false, error: "empty response", ms: Date.now() - started }); last = { error: "empty response", ...result }; continue; }
      attempts.push({ model: id, transport: route.transport, ok: true, ms: Date.now() - started });
      return finish({ ok: true, model: id, transport: route.transport, valid: null, errors: [], ...result, attempts });
    }

    let check = judge(schema, text);
    if (!check.valid) {
      // One retry on the same model, showing it exactly what was wrong.
      attempts.push({ model: id, transport: route.transport, ok: false, error: `reply did not match the schema: ${check.summary}`, retry: "with the validation errors", ms: Date.now() - started });
      const again = [...messages, { role: "assistant", content: text }, { role: "user", content: `That reply does not conform to the required JSON Schema:\n${check.summary}\nReply again with only the corrected JSON value.` }];
      try {
        const r2 = await call(again);
        text = stripThinking(r2.text);
        result = { text, finishReason: r2.finishReason, usage: sumUsage(result.usage, r2.usage), truncated: result.truncated || r2.truncated, numCtx: r2.numCtx || result.numCtx };
        check = judge(schema, text);
      } catch (e) {
        if (signal?.aborted) throw new CompletionError("Cancelled", { cancelled: true, attempts });
        attempts.push({ model: id, transport: route.transport, ok: false, status: e.status || null, error: e.message, ms: Date.now() - started });
        last = { error: e.message, ...result, valid: false, errors: check.errors };
        continue;
      }
    }
    attempts.push({ model: id, transport: route.transport, ok: check.valid, ...(check.valid ? {} : { error: `reply did not match the schema: ${check.summary}` }), ms: Date.now() - started });
    if (check.valid) return finish({ ok: true, model: id, transport: route.transport, parsed: check.value, valid: true, errors: [], ...result, attempts });
    last = { error: `reply did not match the schema: ${check.summary}`, model: id, transport: route.transport, ...result, valid: false, errors: check.errors };
  }

  return finish({ ok: false, valid: schema ? false : null, errors: [], text: "", ...(last || {}), error: (last && last.error) || "no model answered", attempts });
}

function judge(schema, text) {
  const found = extractJson(text);
  if (!found) return { valid: false, errors: [{ path: "/", message: "no JSON value in the reply" }], summary: "- /: no JSON value in the reply" };
  const errors = validate(schema, found.value);
  return { valid: !errors.length, value: found.value, errors, summary: describe(errors) };
}

function sumUsage(a, b) {
  if (!a) return b; if (!b) return a;
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = a[k] == null && b[k] == null ? null : (a[k] || 0) + (b[k] || 0);
  return out;
}

function finish(r) {
  return {
    ok: r.ok, text: r.text || "", ...(r.parsed !== undefined ? { parsed: r.parsed } : {}),
    valid: r.valid, errors: r.errors || [],
    model: r.model || null, transport: r.transport || null,
    usage: r.usage || null, truncated: Boolean(r.truncated), finishReason: r.finishReason || null,
    ...(r.numCtx ? { numCtx: r.numCtx } : {}),
    attempts: r.attempts, ...(r.ok ? {} : { error: r.error }),
    toolFree: true,
  };
}

module.exports = { complete, extractJson, contextFor, routeFor, CompletionError };
