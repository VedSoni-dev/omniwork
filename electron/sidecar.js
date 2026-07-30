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
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is a healthy gateway answering on `port`? Always bounded: a process that
// accepts the connection and then never replies must not park us forever.
// Exported for tests.
async function probeGateway(port, timeoutMs = 2000, host = HOST) {
  try {
    const res = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status === 401;
  } catch { return false; }
}

// Could we actually bind this port, or is something else holding it? Asking the
// OS directly is the only way left to tell: since the child's output goes to
// /dev/null (so a detached gateway can outlive us without taking EPIPE), we
// never get to read its EADDRINUSE on the way out.
function portAvailable(port, host = HOST) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

// Ask the OS for a port nobody is using. Only needed when our well-known port is
// held by something we can't use and mustn't kill.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

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
//
// NOTE: the gateway runs on a real Node binary, not Electron, so it cannot read
// anything inside app.asar — plain Node has no idea what an asar archive is.
// Every module the engine resolves (next and its whole tree, better-sqlite3,
// sql.js) therefore has to exist as real files on disk, which is why the build
// config unpacks all of node_modules rather than a hand-picked list. If you ever
// narrow `asarUnpack`, the gateway dies at launch with MODULE_NOT_FOUND.
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
    // Normally the well-known port, so other OmniWork processes can discover and
    // adopt us. Only moves if that port turns out to be unusable (see start()).
    this.port = PORT;
    this.baseUrl = BASE_URL;
  }

  #setPort(port) {
    this.port = port;
    this.baseUrl = `http://${HOST}:${port}/v1`;
  }

  status(state, detail) {
    this.onStatus({ state, detail, baseUrl: this.baseUrl });
  }

  // Is something already serving the gateway on our port? Happens when a previous
  // run left the sidecar behind, or when the MCP server booted one first. Adopting
  // it beats failing on EADDRINUSE or racing a second copy onto the same DB.
  async #adoptRunning() {
    return probeGateway(this.port, 2000);
  }

  // Something already holds the port. Give it a chance to be a gateway that was
  // simply slower to come up than the 2s startup probe allowed.
  async #probePatiently(port, budgetMs) {
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      if (this._stopped) return false;
      if (await probeGateway(port, 3000)) return true;
      await sleep(1000);
    }
    return false;
  }

  async start() {
    this.status("boot", "Launching OmniRoute…");
    this._stopped = false;

    if (await this.#adoptRunning()) {
      this.ready = true;
      this.adopted = true; // not ours to kill on shutdown
      this.status("ready", "OmniRoute · free models");
      this.#watchdog(); // adopted gateways can die under us (their owner exits)
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

    // Nobody healthy answered above, so if we also cannot bind the port then
    // something is sitting on it without serving — a gateway wedged by an
    // earlier hard kill, usually. Spawning into that just dies on EADDRINUSE,
    // and every later launch dies the same way until someone finds the process
    // by hand. Two outs, in order of preference.
    if (!(await portAvailable(this.port))) {
      this.status("boot", "Port in use — looking for a healthy gateway…");
      // It may simply have been slower to boot than the 2s startup probe.
      if (await this.#probePatiently(this.port, 20_000)) {
        this.ready = true;
        this.adopted = true; // not ours to kill on shutdown
        this.status("ready", "OmniRoute · free models");
        this.#watchdog();
        return this.baseUrl;
      }
      // Genuinely wedged. Move rather than kill: that process may not belong to
      // OmniWork, and taking a port by force isn't a decision to make for the user.
      const alt = await freePort();
      this.#setPort(alt);
      this.status("boot", `Port ${PORT} is blocked — starting on ${alt}…`);
    }

    const env = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(this.port), // may differ from PORT if the well-known one was blocked
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

    // Corrupt gateway storage (e.g. after a hard kill) makes the server listen
    // but never turn healthy. If the first boot times out, quarantine the DB
    // and try once more with a fresh one.
    for (let attempt = 0; ; attempt++) {
      // stop() may have landed while we were awaiting above (the watchdog can be
      // mid-restart when the app quits). Spawning now would strand a gateway on
      // the port with nobody left to kill it.
      if (this._stopped) throw new Error("gateway start aborted by shutdown");
      this.#spawnServer(serverEntry, omniDir, env);
      try {
        await this.#waitHealthy();
        if (this._stopped) { this.#killProc(); throw new Error("gateway start aborted by shutdown"); }
        this.#watchdog();
        return this.baseUrl;
      } catch (e) {
        // #killProc, not stop(): this is a retry, not a shutdown, so it must not
        // latch the abort flag that stop() sets.
        this.#killProc();
        const db = path.join(gwDataDir, "storage.sqlite");
        if (!this._stopped && attempt === 0 && fs.existsSync(db)) {
          this.status("boot", "Recovering gateway storage…");
          try { fs.renameSync(db, db + ".corrupt-" + Date.now() + ".bak"); } catch {}
          continue;
        }
        throw e;
      }
    }
  }

  #spawnServer(serverEntry, omniDir, env) {
    this._exited = false;
    // Never pipe to us: the gateway is meant to outlive this process (see
    // #adoptRunning), and a detached child writing to a pipe whose reader has
    // exited takes EPIPE and dies. /dev/null by default; in DEV, append to a
    // log file instead so the output is still there to read.
    let stdio = ["ignore", "ignore", "ignore"];
    let logFd = null;
    if (process.env.OMNIWORK_DEV) {
      try {
        logFd = fs.openSync(path.join(this.dataDir, "omniroute-sidecar.log"), "a");
        stdio = ["ignore", logFd, logFd];
      } catch { /* keep ignore */ }
    }

    // detached: gives the child its own process group so stop() can take down
    // any workers Next.js spawned, not just the parent.
    this.proc = spawn(this.nodeBinary, [serverEntry], {
      cwd: path.join(omniDir, "dist"),
      env,
      stdio,
      detached: process.platform !== "win32",
    });

    // The child dup'd the fd; ours would otherwise leak on every watchdog respawn.
    if (logFd !== null) { try { fs.closeSync(logFd); } catch {} }

    this.proc.on("exit", (code) => {
      this.ready = false;
      this._exited = true; // lets #waitHealthy give up now instead of at the deadline
      if (code && code !== 0) this.status("error", `Gateway exited (code ${code})`);
    });
    this.proc.on("error", (e) => { this._exited = true; this.status("error", e.message); });
  }

  // A gateway can vanish after we're "ready": an adopted one dies with its
  // owner, or our own child crashes. Probe every 20s; if it's gone, take
  // ownership and boot a fresh one on the same port — agents recover
  // transparently since the base URL never changes.
  #watchdog() {
    clearInterval(this._watch);
    if (this._stopped) return; // shutting down — do not resurrect the engine
    this._watch = setInterval(async () => {
      if (this._stopped || this._restarting || (await this.#adoptRunning())) return;
      this._restarting = true;
      this.ready = false;
      this.adopted = false;
      this.status("boot", "Engine went away — restarting…");
      try { await this.start(); } catch {}
      this._restarting = false;
    }, 20_000);
    if (this._watch.unref) this._watch.unref();
  }

  async #waitHealthy(timeoutMs = 90000) {
    const started = Date.now();
    const url = `http://${HOST}:${this.port}/v1/models`;
    let sick = 0; // listening but 5xx — broken storage, not "still booting"
    while (Date.now() - started < timeoutMs) {
      // Our child is already gone. Polling the port for another 80s would only
      // be asking whoever else holds it how they are getting on.
      if (this._exited) throw new Error("gateway exited during startup");
      try {
        // Without a per-request timeout, a process that accepts the connection
        // and then never answers parks this fetch for undici's 300s default —
        // and the loop's own deadline is only checked between iterations, so it
        // never gets to fire.
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok || res.status === 401) {
          this.ready = true;
          this.status("ready", "OmniRoute · free models");
          return;
        }
        if (res.status >= 500 && ++sick >= 5) break;
      } catch {
        sick = 0; // not up yet
      }
      await sleep(700);
    }
    this.status("error", "Gateway did not start in time");
    throw new Error("gateway health timeout");
  }

  dashboardUrl() {
    return `http://${HOST}:${this.port}/`;
  }

  stop() {
    // Set before anything else: an in-flight start() checks this to avoid
    // spawning a gateway we would then have no handle on.
    this._stopped = true;
    clearInterval(this._watch);
    this.#killProc();
  }

  // Tear down the child process without signalling shutdown intent, so start()
  // can reuse it between retry attempts.
  #killProc() {
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

module.exports = { Gateway, PORT, BASE_URL, probeGateway, portAvailable, freePort };
