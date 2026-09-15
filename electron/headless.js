"use strict";
// Shared bootstrap for the headless stdio servers (mcp-server.js, acp-server.js).
//
// Both run on plain Node — no Electron, no renderer — and both need the same
// three things: the OmniRoute gateway, the user's app data dir, and the agent
// environment (skills, memory, project registry) so a delegated or remote-driven
// agent gets everything the desktop app has taught OmniWork.

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { Gateway, PORT } = require("./sidecar");
const { ProjectManager } = require("./projects");
const { BrowserManager } = require("./browser");
const providers = require("./providers");
const { Agent } = require("./agent");
const opencode = require("./opencode-engine");

const HOST = "127.0.0.1";

// Same data dir as the desktop app — headless agents share its installed skills,
// saved memory, and project registry.
function appDataDir() {
  const h = os.homedir();
  if (process.platform === "darwin") return path.join(h, "Library", "Application Support", "omniwork");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "omniwork");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(h, ".config"), "omniwork");
}

const DATA_DIR = appDataDir();
const SKILLS_DIR = path.join(DATA_DIR, "skills");
const GLOBAL_MEMORY_DIR = path.join(DATA_DIR, "memory");

const browser = new BrowserManager(); // search + static page fetch (no Electron here)
let projectsMgr = null;
const projects = () => (projectsMgr ||= new ProjectManager(path.join(DATA_DIR, "projects")));

function agentEnv(workspace) {
  return {
    skillsDir: SKILLS_DIR,
    browser,
    memory: {
      globalDir: GLOBAL_MEMORY_DIR,
      projectDir: projects().memoryDir(projects().forWorkspace(workspace).id),
    },
  };
}

// ── gateway ───────────────────────────────────────────────────────
// A headless server can point its agents at any OpenAI-compatible endpoint.
// Unset (the default) means the bundled OmniRoute gateway on free models.
function externalGateway() {
  const baseUrl = process.env.OMNIWORK_BASE_URL;
  if (!baseUrl) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey: process.env.OMNIWORK_API_KEY || "omniwork" };
}

let gatewayInfo = null;
let booting = null;

// Booting OmniRoute cold takes tens of seconds (Next.js standalone server), and
// that cost used to land on the caller's first request. Kick it off as soon as a
// client connects so it overlaps with the host reading our tool list and
// deciding what to do — by the time real work arrives the gateway is usually up.
function prewarmGateway(log = () => {}) {
  if (process.env.OMNIWORK_NO_PREWARM) return;
  ensureGateway(log).catch(() => {});
}

async function ensureGateway(log = () => {}) {
  if (gatewayInfo) return gatewayInfo;
  const ext = externalGateway();
  if (ext) { gatewayInfo = ext; log("using external gateway", ext.baseUrl); return gatewayInfo; }
  if (booting) return booting;

  booting = (async () => {
    // Reuse a gateway already running (e.g. the desktop app) before spawning one.
    try {
      const res = await fetch(`http://${HOST}:${PORT}/v1/models`, { signal: AbortSignal.timeout(2500) });
      if (res.ok || res.status === 401) {
        gatewayInfo = { baseUrl: `http://${HOST}:${PORT}/v1`, apiKey: "omniwork" };
        log("reusing running gateway");
        return gatewayInfo;
      }
    } catch {}
    log("starting bundled gateway…");
    const dataDir = path.join(os.homedir(), ".omniwork");
    fs.mkdirSync(dataDir, { recursive: true });
    const gw = new Gateway({ dataDir, onStatus: (s) => log("gateway", s.state, s.detail || "") });
    await gw.start();
    gatewayInfo = { baseUrl: gw.baseUrl, apiKey: gw.apiKey };
    return gatewayInfo;
  })();

  try { return await booting; }
  finally { booting = null; }
}

// ── models ────────────────────────────────────────────────────────
// Which model a headless agent runs on, and what to try if it fails. An
// explicit choice (a delegate call's `model`, an ACP session's config) wins
// over the env, which wins over `auto` — the gateway's free pool. The fallback
// chain is what lets a harness pin a specific coding model and still get an
// answer when that model is retired, out of quota, or behind a provider key it
// doesn't have: "free first, paid if needed" is spelled as a chain that ends in
// a paid model.
function parseModelList(v) {
  const raw = Array.isArray(v) ? v : String(v || "").split(",");
  return raw.map((m) => String(m || "").trim()).filter(Boolean);
}

function resolveModels({ model, fallbackModels } = {}) {
  const primary = String(model || process.env.OMNIWORK_MODEL || "auto").trim() || "auto";
  const chain = parseModelList(fallbackModels != null ? fallbackModels : process.env.OMNIWORK_MODEL_FALLBACKS);
  return { model: primary, fallbackModels: chain.filter((m) => m !== primary) };
}

// The gateway's catalog, cached briefly: an ACP client asks for it on every
// session, and it only changes when someone adds a provider key.
let modelCache = { at: 0, ids: [] };
async function listModels(gw) {
  if (Date.now() - modelCache.at < 30_000) return modelCache.ids;
  let ids = modelCache.ids;
  try {
    const res = await fetch(`${gw.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${gw.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      ids = (data.data || []).map((m) => m && m.id).filter((id) => typeof id === "string" && id);
    }
  } catch {}
  modelCache = { at: Date.now(), ids };
  return ids;
}

// The chain a headless agent falls back to when the caller named none: the
// best model of every connected free provider, then any local server. Set
// OMNIWORK_MODEL_FALLBACKS (even to empty) to take over the decision.
let chainCache = { at: 0, chain: [] };
async function defaultFallbacks(gw) {
  if (Date.now() - chainCache.at < 30_000) return chainCache.chain;
  const chain = providers.suggestChain(await listModels(gw));
  chainCache = { at: Date.now(), chain };
  return chain;
}

// Connecting a provider changes both caches; call this right after.
function invalidateModels() { modelCache = { at: 0, ids: [] }; chainCache = { at: 0, chain: [] }; }

async function resolveModelsLive(gw, opts = {}) {
  const r = resolveModels(opts);
  const decided = opts.fallbackModels != null || process.env.OMNIWORK_MODEL_FALLBACKS != null;
  if (!decided) r.fallbackModels = (await defaultFallbacks(gw)).filter((m) => m !== r.model);
  return r;
}

// What to tell a caller whose every model failed. The built-in free pool is
// the usual culprit, and the fix is one connection away.
function noModelHint() {
  const oc = opencode.available()
    ? "OpenCode is installed, so `opencode/…` models are available as an engine — pick one, or let the fallback switch to it."
    : `Getting OpenCode (${opencode.INSTALL_COMMAND}, a ~45 MB download) adds its free Zen models as an engine that needs no account at all.`;
  return "No model answered. The gateway's built-in free pool is unreliable (its keyless endpoints get shut off upstream) — connect a real free provider once: run `npm run providers` in the omniwork checkout (or `npx omniwork-providers`), use the free-models panel in the OmniWork app, or the OpenRouter auth method on ACP. " + oc;
}

// ── agents ────────────────────────────────────────────────────────
// `opencode/<model>` runs on the OpenCode engine (OpenCode's own server and
// tools, on Zen's free models); anything else on OmniWork's loop via the gateway.
function makeAgent(opts) {
  return opencode.isEngineModel(opts.model) ? new opencode.OpenCodeAgent(opts) : new Agent(opts);
}

// A turn that ended because no model answered — as opposed to a tool error,
// a cancel, or a model that answered badly.
const isNoModelFailure = (msg) => /All models failed|Gateway (401|403|404|429|503)|No choices returned|empty response/.test(String(msg || ""));

// The engine's best free model, when OpenCode is installed; null otherwise.
async function engineFallbackModel() {
  if (!opencode.available()) return null;
  try {
    const list = await opencode.getEngine().models();
    return list.length ? list[0].id : `${opencode.PREFIX}nemotron-3.5-lightning-free`;
  } catch { return null; }
}


module.exports = {
  DATA_DIR, SKILLS_DIR, GLOBAL_MEMORY_DIR,
  browser, projects, agentEnv,
  ensureGateway, prewarmGateway,
  resolveModels, resolveModelsLive, listModels, defaultFallbacks, invalidateModels, noModelHint, providers,
  makeAgent, isNoModelFailure, engineFallbackModel, opencode,
};
