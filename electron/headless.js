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

module.exports = {
  DATA_DIR, SKILLS_DIR, GLOBAL_MEMORY_DIR,
  browser, projects, agentEnv,
  ensureGateway, prewarmGateway,
};
