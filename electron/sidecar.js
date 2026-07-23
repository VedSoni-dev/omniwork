"use strict";
// Manages the bundled OmniRoute gateway as a child process ("sidecar").
// This is the whole point of OmniWork: the AI router ships *inside* the app,
// so the user never installs or configures anything.

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const PORT = Number(process.env.OMNIWORK_GATEWAY_PORT || 20128);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}/v1`;

// Resolve the omniroute CLI entry, accounting for electron-builder's asar unpack.
function resolveOmnirouteEntry() {
  let entry;
  try {
    entry = require.resolve("omniroute/bin/omniroute.mjs");
  } catch {
    // Fall back to a manual path under node_modules.
    entry = path.join(__dirname, "..", "node_modules", "omniroute", "bin", "omniroute.mjs");
  }
  // When packaged, native + omniroute live in app.asar.unpacked.
  if (entry.includes("app.asar" + path.sep)) {
    const unpacked = entry.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
    if (fs.existsSync(unpacked)) entry = unpacked;
  }
  return entry;
}

// A stable local API key. OmniRoute keys are managed in its own store, but we
// generate/persist one here and hand it to the gateway via env so the agent can
// authenticate without any user setup. Persisted in the app data dir.
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
  constructor({ dataDir, execPath, onStatus }) {
    this.dataDir = dataDir;
    this.execPath = execPath; // Electron binary, reused as Node via ELECTRON_RUN_AS_NODE
    this.onStatus = onStatus || (() => {});
    this.apiKey = ensureApiKey(dataDir);
    this.proc = null;
    this.ready = false;
    this.baseUrl = BASE_URL;
  }

  status(state, detail) {
    this.onStatus({ state, detail, baseUrl: this.baseUrl });
  }

  async start() {
    this.status("boot", "Launching OmniRoute…");
    const entry = resolveOmnirouteEntry();
    if (!fs.existsSync(entry)) {
      this.status("error", "OmniRoute not found in bundle");
      throw new Error("omniroute entry missing: " + entry);
    }

    const gwDataDir = path.join(this.dataDir, "omniroute");
    fs.mkdirSync(gwDataDir, { recursive: true });

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // run the Electron binary as plain Node
      NODE_ENV: "production",
      PORT: String(PORT),
      OMNIROUTE_PORT: String(PORT),
      HOST,
      // Point OmniRoute's data/config at our per-user app dir (several common env names).
      OMNIROUTE_DATA_DIR: gwDataDir,
      OMNIROUTE_HOME: gwDataDir,
      XDG_DATA_HOME: gwDataDir,
      // Seed the API key via the common env conventions; harmless if ignored.
      OMNIROUTE_API_KEY: this.apiKey,
      OMNIROUTE_DEFAULT_API_KEY: this.apiKey,
      OMNIROUTE_MASTER_KEY: this.apiKey,
    };

    this.proc = spawn(this.execPath, [entry], {
      cwd: gwDataDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
    const endpoints = [`http://${HOST}:${PORT}/v1/models`, `http://${HOST}:${PORT}/`];
    while (Date.now() - started < timeoutMs) {
      for (const url of endpoints) {
        try {
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
          });
          // Any HTTP response (even 401) means the server is up and listening.
          if (res.status > 0) {
            this.ready = true;
            this.status("ready", "OmniRoute · free models");
            return;
          }
        } catch {
          // not up yet
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    this.status("error", "Gateway did not start in time");
    throw new Error("gateway health timeout");
  }

  dashboardUrl() {
    return `http://${HOST}:${PORT}/`;
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
    this.proc = null;
    this.ready = false;
  }
}

module.exports = { Gateway, PORT, BASE_URL };
