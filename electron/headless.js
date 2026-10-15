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
const { Gateway, findRunningGateway } = require("./sidecar");
const { ProjectManager } = require("./projects");
const { BrowserManager } = require("./browser");
const providers = require("./providers");
const { Agent, isNoModelFailure } = require("./agent");
const opencode = require("./opencode-engine");

// Same data dir as the desktop app — headless agents share its installed skills,
// saved memory, and project registry.
function appDataDir() {
  const h = os.homedir();
  if (process.platform === "darwin") return path.join(h, "Library", "Application Support", "omniwork");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "omniwork");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(h, ".config"), "omniwork");
}

const DATA_DIR = process.env.OMNIWORK_DATA_DIR || appDataDir();
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

// Headless servers used to keep their own gateway store in ~/.omniwork, so
// which provider list was live depended on whether the app or a headless
// server had started the gateway. One store now; the first time a headless
// server starts the gateway, an old headless store moves over if the shared
// one has none. Nothing is deleted: the old files stay where they were.
function adoptLegacyStore(from, to) {
  const db = "storage.sqlite";
  if (path.resolve(from) === path.resolve(to)) return null;
  if (!fs.existsSync(path.join(from, db))) return null;
  if (fs.existsSync(path.join(to, db))) {
    return `another gateway store exists at ${from}; using ${to} (the desktop app's). Connect providers again here if they're missing.`;
  }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const f of [db, db + "-wal", db + "-shm"]) {
    if (fs.existsSync(path.join(from, f))) { fs.copyFileSync(path.join(from, f), path.join(to, f)); fs.chmodSync(path.join(to, f), 0o600); }
  }
  try { fs.writeFileSync(path.join(from, "MOVED.txt"), `This gateway store was copied to ${to} on ${new Date().toISOString()}; OmniWork no longer uses this copy.\n`); } catch {}
  return `copied the gateway store from ${from} to ${to}`;
}

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
    // Reuse a gateway already running (e.g. the desktop app) before spawning
    // one — at the port and with the key the shared state file names.
    const running = await findRunningGateway({ timeoutMs: 2500 });
    if (running) {
      gatewayInfo = { baseUrl: running.baseUrl, apiKey: running.apiKey };
      log("reusing running gateway on port", running.port);
      return gatewayInfo;
    }
    log("starting bundled gateway…");
    // The desktop app's data dir, so a provider connected in the app is
    // there for MCP, ACP and the CLI too (and the other way round).
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const moved = adoptLegacyStore(path.join(os.homedir(), ".omniwork", "omniroute"), path.join(DATA_DIR, "omniroute"));
    if (moved) log(moved);
    const gw = new Gateway({ dataDir: DATA_DIR, onStatus: (s) => log("gateway", s.state, s.detail || "") });
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
let modelCache = { at: 0, ids: [], contexts: {} };
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
      modelCache.contexts = Object.fromEntries((data.data || []).filter(m => m.id && (m.context_length || m.max_input_tokens)).map(m => [m.id, m.context_length || m.max_input_tokens]));
      ids = (data.data || []).map((m) => m && m.id).filter((id) => typeof id === "string" && id);
    }
  } catch {}
  modelCache = { ...modelCache, at: Date.now(), ids };
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
  await listModels(gw); // Pinned models need context metadata too.
  const decided = opts.fallbackModels != null || process.env.OMNIWORK_MODEL_FALLBACKS != null;
  if (!decided) r.fallbackModels = (await defaultFallbacks(gw)).filter((m) => m !== r.model);
  // OMNIWORK_PREFER_LOCAL=1: when nothing more specific than `auto` was asked
  // for, a connected local model goes first, with the cloud chain behind it.
  const isLocal = (id) => providers.LOCAL.some((l) => id.startsWith(l.alias + "/"));
  if (!decided && r.model === "auto" && /^(1|true|yes|on)$/i.test(process.env.OMNIWORK_PREFER_LOCAL || "")) {
    const local = r.fallbackModels.find(isLocal);
    if (local) { r.fallbackModels = [...r.fallbackModels.filter((m) => m !== local), "auto"]; r.model = local; }
  }
  return { ...r, modelContexts: modelCache.contexts, contextTokens: modelCache.contexts?.[r.model] };
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


// The engine's best free model, when OpenCode is installed; null otherwise.
async function engineFallbackModel() {
  // OMNIWORK_ENGINE_FALLBACK=off keeps a failed turn failed rather than
  // finishing it on OpenCode's free tier.
  if (/^(0|off|false|no)$/i.test(String(process.env.OMNIWORK_ENGINE_FALLBACK || ""))) return null;
  if (!opencode.available()) return null;
  try {
    const list = (await opencode.getEngine().models()).filter(m => m.free && m.tools !== false);
    return list.length ? list[0].id : null;
  } catch { return null; }
}


module.exports = {
  DATA_DIR, SKILLS_DIR, GLOBAL_MEMORY_DIR, adoptLegacyStore,
  browser, projects, agentEnv,
  ensureGateway, prewarmGateway,
  resolveModels, resolveModelsLive, listModels, defaultFallbacks, invalidateModels, noModelHint, providers,
  makeAgent, isNoModelFailure, engineFallbackModel, opencode,
};
