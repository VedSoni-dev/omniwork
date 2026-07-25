"use strict";
// Manages the bundled OmniRoute gateway as a child process ("sidecar").
// This is the whole point of OmniWork: the AI router ships *inside* the app,
// so the user never installs or configures anything.
//
// We spawn OmniRoute's prebuilt Next.js standalone server (dist/server.js)
// with a real Node binary that we bundle alongside the app. OmniRoute's server
// does not boot correctly on Electron's embedded Node (Next.js worker /
// instrumentation incompatibilities), so a genuine Node runtime is required.
// In dev we fall back to the system `node` (or $OMNIWORK_NODE).

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

// The Node binary used to run the gateway. Packaged builds ship one under
// resources/runtime (see scripts/stage-node.js); dev uses system node.
function resolveNodeBinary() {
  const bin = process.platform === "win32" ? "node.exe" : "node";
  const bundled = path.join(process.resourcesPath || "", "runtime", bin);
  if (process.resourcesPath && fs.existsSync(bundled)) return bundled;
  return process.env.OMNIWORK_NODE || "node";
}

const PORT = Number(process.env.OMNIWORK_GATEWAY_PORT || 20128);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}/v1`;

// Locate a BUNDLED omniroute package dir (full build). Returns null if the
// engine isn't packaged with the app (lite build) — the caller then downloads it.
function resolveBundledOmniroute() {
  let pkgJson = null;
  try { pkgJson = require.resolve("omniroute/package.json"); } catch {}
  if (!pkgJson) {
    const p = path.join(__dirname, "..", "node_modules", "omniroute", "package.json");
    if (fs.existsSync(p)) pkgJson = p;
  }
  if (!pkgJson) return null;
  let dir = path.dirname(pkgJson);
  if (dir.includes("app.asar" + path.sep)) {
    const unpacked = dir.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
    if (fs.existsSync(unpacked)) dir = unpacked;
  }
  return fs.existsSync(path.join(dir, "dist", "server.js")) ? dir : null;
}

// A stable local key we keep for future use (provider dashboard, etc.). The
// gateway serves localhost openly, so requests don't require it, but we persist
// one so the app has a consistent identity.
function ensureApiKey(dataDir) {
  const keyFile = path.join(dataDir, "gateway-key.txt");
  try {
    if (fs.existsSync(keyFile)) {
      const k = fs.readFileSync(keyFile, "utf8").trim();
      if (k) return k;
    }
  } catch {}
  const key = "ow-" + crypto.randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyFile, key, "utf8");
  } catch {}
  return key;
}

class Gateway {
  constructor({ dataDir, onStatus }) {
    this.dataDir = dataDir;
    this.nodeBinary = resolveNodeBinary();
    this.onStatus = onStatus || (() => {});
    this.apiKey = ensureApiKey(dataDir);
    this.proc = null;
    this.ready = false;
    this.adopted = false; // true when we reused a gateway we didn't spawn
    this.baseUrl = BASE_URL;
  }

  status(state, detail) {
    this.onStatus({ state, detail, baseUrl: this.baseUrl });
  }

  // Is something already serving the gateway on our port? Happens when a previous
  // run left the sidecar behind, or when the MCP server booted one first. Adopting
  // it beats failing on EADDRINUSE or racing a second copy onto the same DB.
  async #adoptRunning() {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/v1/models`, { signal: AbortSignal.timeout(2000) });
      return res.ok || res.status === 401;
    } catch { return false; }
  }

  async start() {
    this.status("boot", "Launching OmniRoute…");

    if (await this.#adoptRunning()) {
      this.ready = true;
      this.adopted = true; // not ours to kill on shutdown
      this.status("ready", "OmniRoute · free models");
      return this.baseUrl;
    }

    // Full build: engine is bundled. Lite build: download it to the data dir once.
    let omniDir = resolveBundledOmniroute();
    if (!omniDir) {
      const { engineDir, engineReady, downloadEngine } = require("./engine-fetch");
      const ed = engineDir(this.dataDir);
      if (engineReady(ed)) {
        omniDir = ed;
      } else {
        this.status("boot", "Downloading engine (first run, ~1 min)…");
        try {
          omniDir = await downloadEngine(this.dataDir, (s) => this.status("boot", s.detail));
        } catch (e) {
          this.status("error", "Engine download failed: " + e.message);
          throw e;
        }
      }
    }
    const serverEntry = path.join(omniDir, "dist", "server.js");
    if (!fs.existsSync(serverEntry)) {
      this.status("error", "OmniRoute server not found");
      throw new Error("omniroute dist/server.js missing: " + serverEntry);
    }

    // OmniRoute keeps its encrypted store + config here. Per-user app data dir.
    const gwDataDir = path.join(this.dataDir, "omniroute");
    fs.mkdirSync(gwDataDir, { recursive: true });

    const env = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: HOST, // bind loopback only
      DATA_DIR: gwDataDir, // OmniRoute reads DATA_DIR for its storage + .env
      // Let the free "auto" pool fall back to the full pool if a sub-combo is empty.
      OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL: "true",
      // Skip outbound startup syncs — faster, quieter, works offline.
      ARENA_ELO_SYNC_ENABLED: "false",
      PRICING_SYNC_ENABLED: "false",
    };
    // Ensure no stray Electron-as-node flag leaks into the child.
    delete env.ELECTRON_RUN_AS_NODE;

    // detached: gives the child its own process group so stop() can take down
    // any workers Next.js spawned, not just the parent.
    this.proc = spawn(this.nodeBinary, [serverEntry], {
      cwd: path.join(omniDir, "dist"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    this.proc.stdout.on("data", (d) => this.#log(d));
    this.proc.stderr.on("data", (d) => this.#log(d));
    this.proc.on("exit", (code) => {
      this.ready = false;
      if (code && code !== 0) this.status("error", `Gateway exited (code ${code})`);
    });
    this.proc.on("error", (e) => this.status("error", e.message));

    await this.#waitHealthy();
    return this.baseUrl;
  }

  #log(d) {
    const line = d.toString().trim();
    if (line && process.env.OMNIWORK_DEV) console.log("[omniroute]", line);
  }

  async #waitHealthy(timeoutMs = 90000) {
    const started = Date.now();
    const url = `http://${HOST}:${PORT}/v1/models`;
    while (Date.now() - started < timeoutMs) {
      try {
        const res = await fetch(url);
        if (res.ok || res.status === 401) {
          this.ready = true;
          this.status("ready", "OmniRoute · free models");
          return;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    this.status("error", "Gateway did not start in time");
    throw new Error("gateway health timeout");
  }

  dashboardUrl() {
    return `http://${HOST}:${PORT}/`;
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    // We adopted someone else's gateway — leave it running for its owner.
    if (this.adopted || !proc || proc.killed || proc.exitCode !== null) return;

    // Signal the whole process group (see `detached` in start()) so Next.js
    // workers go down with the parent instead of orphaning onto the port.
    const signal = (sig) => {
      try { process.platform === "win32" ? proc.kill(sig) : process.kill(-proc.pid, sig); }
      catch { try { proc.kill(sig); } catch {} }
    };
    signal("SIGTERM");
    // If it hasn't gone in 3s, stop asking nicely. Unref so a clean exit isn't
    // held open waiting on this timer.
    const t = setTimeout(() => { if (proc.exitCode === null) signal("SIGKILL"); }, 3000);
    if (t.unref) t.unref();
  }
}

module.exports = { Gateway, PORT, BASE_URL };
