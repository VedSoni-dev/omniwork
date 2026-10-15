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
const os = require("node:os");
const crypto = require("node:crypto");
const { gatewayEnv } = require("./child-env");

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

// ── gateway storage ───────────────────────────────────────────────
// storage.sqlite holds every provider connection the user made, so it is only
// set aside when it is provably corrupt. A boot that times out — a slow disk, a
// cold Next.js start, a port race — says nothing about the database.
const STORAGE = "storage.sqlite";
const KEEP_BACKUPS = 2;

// "ok" | "corrupt" | "unknown". Asks SQLite itself (quick_check, read-only)
// through the gateway's Node binary: Electron's embedded Node has no
// node:sqlite. Only SQLITE_CORRUPT / SQLITE_NOTADB count as corrupt; anything
// that can't be decided keeps the file.
const CHECK_SCRIPT = `
let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch { process.exit(3); }
try {
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  const rows = db.prepare("PRAGMA quick_check").all();
  db.close();
  process.stdout.write(rows.length === 1 && Object.values(rows[0])[0] === "ok" ? "ok" : "corrupt");
} catch (e) {
  const code = (e.errcode || 0) & 0xff;
  process.stdout.write(code === 11 || code === 26 || /malformed|not a database/i.test(e.message) ? "corrupt" : "unknown");
}`;

function runCheck(nodeBinary, file, flags) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try { child = spawn(nodeBinary, [...flags, "-e", CHECK_SCRIPT, file], { stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }); }
    catch { return resolve(null); }
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 3 ? null : (["ok", "corrupt"].includes(out) ? out : "unknown")));
  });
}

// Without node:sqlite, only a file that isn't SQLite at all is decided.
function headerVerdict(file) {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return "unknown";
    if (size < 100) return "corrupt";
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    return head.toString("latin1") === "SQLite format 3\0" ? "unknown" : "corrupt";
  } catch { return "unknown"; }
}

async function checkStorage(file, nodeBinary = resolveNodeBinary()) {
  if (!fs.existsSync(file)) return "unknown";
  // Older Node 22 releases ship node:sqlite behind a flag.
  const verdict = (await runCheck(nodeBinary, file, [])) || (await runCheck(nodeBinary, file, ["--experimental-sqlite"]));
  return verdict || headerVerdict(file);
}

// Backups hold provider keys: owner-only, and only the newest few are kept.
function storageBackups(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  return names.filter((n) => /^storage\.sqlite\.corrupt-\d+\.bak$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
}

function protectBackups(dir) {
  for (const n of storageBackups(dir)) for (const f of [n, n + "-wal", n + "-shm"]) {
    try { fs.chmodSync(path.join(dir, f), 0o600); } catch {}
  }
}

// Moves the database aside with its WAL and shared-memory files — a WAL left
// behind would be replayed into the fresh database — then prunes old backups.
function quarantineStorage(dir, now = Date.now()) {
  const backup = `${STORAGE}.corrupt-${now}.bak`;
  for (const [from, to] of [[STORAGE, backup], [STORAGE + "-wal", backup + "-wal"], [STORAGE + "-shm", backup + "-shm"]]) {
    try { fs.renameSync(path.join(dir, from), path.join(dir, to)); fs.chmodSync(path.join(dir, to), 0o600); } catch {}
  }
  for (const old of storageBackups(dir).slice(KEEP_BACKUPS)) {
    for (const f of [old, old + "-wal", old + "-shm"]) fs.rmSync(path.join(dir, f), { force: true });
  }
  return path.join(dir, backup);
}

// ── shared runtime state ──────────────────────────────────────────
// One place every OmniWork entry point (desktop, MCP, ACP, CLI, job service)
// finds the running gateway: the port it is on — which moves when 20128 is
// taken — and the key it was started with. Owner-only, like the key itself.
function runtimeDir() { return process.env.OMNIWORK_RUNTIME_DIR || path.join(os.homedir(), ".omniwork"); }
const stateFile = () => path.join(runtimeDir(), "gateway.json");

function writePrivate(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readGatewayState() {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return Number.isInteger(st.port) && st.port > 0 && st.port < 65536 && typeof st.key === "string" && st.key ? st : null;
  } catch { return null; }
}

// The per-install key every OmniWork client sends, and the only one the
// gateway it starts accepts (REQUIRE_API_KEY): another local account, or a
// web page, can reach a loopback port but cannot read this file.
function ensureApiKey() {
  const keyFile = path.join(runtimeDir(), "gateway-key.txt");
  try {
    const k = fs.readFileSync(keyFile, "utf8").trim();
    if (k) { try { fs.chmodSync(keyFile, 0o600); } catch {} return k; }
  } catch {}
  const key = "ow-" + crypto.randomBytes(24).toString("hex");
  try { writePrivate(keyFile, key); } catch {}
  return key;
}

// "ok" when the gateway on `port` serves this key, "rejected" when something
// answers but refuses it (a gateway started with another key), else "down".
async function probeKey(port, key, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://${HOST}:${port}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? "ok" : res.status === 401 || res.status === 403 ? "rejected" : "down";
  } catch { return "down"; }
}

// A running gateway this process can use: the one the state file names, else
// whatever answers on `port` with our own key (an older OmniWork's gateway
// doesn't check keys). Returns { port, apiKey, baseUrl } or null.
async function findRunningGateway({ port = PORT, key = ensureApiKey(), timeoutMs = 2000 } = {}) {
  const st = readGatewayState();
  const tries = st ? [{ port: st.port, key: st.key }] : [];
  if (!st || st.port !== port || st.key !== key) tries.push({ port, key });
  for (const t of tries) {
    if ((await probeKey(t.port, t.key, timeoutMs)) === "ok") return { port: t.port, apiKey: t.key, baseUrl: `http://${HOST}:${t.port}/v1`, recorded: Boolean(st && st.port === t.port && st.key === t.key), dataDir: st && st.port === t.port ? st.dataDir : null };
  }
  return null;
}

// What the gateway wrote before it ran with a private umask — call logs with
// full prompts, app logs, database backups — made owner-only. Once per process.
const tightened = new Set();
function tightenTree(dir, depth = 0) {
  if (depth === 0) { if (tightened.has(dir)) return; tightened.add(dir); }
  let entries = [];
  try { fs.chmodSync(dir, 0o700); entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 6) tightenTree(p, depth + 1);
    else if (e.isFile()) { try { fs.chmodSync(p, 0o600); } catch {} }
  }
}

// ── keyless OpenCode ──────────────────────────────────────────────
// OmniRoute's built-in "OpenCode Free" provider reaches OpenCode Zen's free
// tier with no key by presenting itself as the OpenCode client. Upstream now
// refuses that ("only from within OpenCode", 403), and impersonating another
// product's client isn't something OmniWork should do — its free Zen models
// run through the real OpenCode binary instead (`opencode/…`, the engine). So
// the header synthesis is off, and the keyless provider is blocked once per
// gateway store — never again if the user re-enables it in the dashboard.
// The keyed providers (opencode-zen, opencode-go) are untouched.
// OMNIWORK_KEYLESS_OPENCODE=on leaves the provider alone.
async function blockKeylessOpenCode(baseUrl, apiKey, gwDataDir) {
  if (/^(1|true|yes|on)$/i.test(process.env.OMNIWORK_KEYLESS_OPENCODE || "")) return "skipped";
  const marker = path.join(gwDataDir, "omniwork-policy.json");
  let policy = {};
  try { policy = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
  if (policy.keylessOpenCodeBlocked) return "done before";
  const url = baseUrl.replace(/\/v1$/, "") + "/api/settings";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`settings HTTP ${res.status}`);
  const current = (await res.json()).blockedProviders;
  const blocked = Array.isArray(current) ? current : [];
  if (!blocked.includes("opencode") && !blocked.includes("oc")) {
    const patched = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ blockedProviders: [...blocked, "opencode"] }), signal: AbortSignal.timeout(5000) });
    if (!patched.ok) throw new Error(`settings HTTP ${patched.status}`);
  }
  writePrivate(marker, JSON.stringify({ ...policy, keylessOpenCodeBlocked: new Date().toISOString() }));
  return "blocked";
}

// The guard (gateway-guard.js) runs inside the gateway's own Node, which can't
// read app.asar — so it is copied next to the gateway's data each start.
function installGuard(dataDir) {
  const src = fs.readFileSync(path.join(__dirname, "gateway-guard.js"), "utf8");
  const dest = path.join(dataDir, "gateway-guard.js");
  let cur = null;
  try { cur = fs.readFileSync(dest, "utf8"); } catch {}
  if (cur !== src) writePrivate(dest, src);
  return dest;
}

class Gateway {
  // `omniDir` and `healthTimeoutMs` exist for tests: a stand-in server and a
  // short deadline instead of the bundled engine's 90s.
  constructor({ dataDir, onStatus, omniDir = null, healthTimeoutMs = 90000, patienceMs = 20_000 }) {
    this.dataDir = dataDir;
    this.omniDirOverride = omniDir;
    this.healthTimeoutMs = healthTimeoutMs;
    this.patienceMs = patienceMs;
    this.notice = null;        // shown with the ready status (e.g. a storage reset)
    this.storageReset = null;  // { at, backup } when corrupt storage was set aside
    this.nodeBinary = resolveNodeBinary();
    this.onStatus = onStatus || (() => {});
    this.apiKey = ensureApiKey();
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

  // Is something already serving the gateway? Happens when a previous run left
  // the sidecar behind, or when the MCP server booted one first. Adopting it
  // beats failing on EADDRINUSE or racing a second copy onto the same DB. Uses
  // the port and key the shared state file names, so a gateway that had to
  // move off the well-known port is still found, with the key it accepts.
  async #adoptRunning(timeoutMs = 2000) {
    const found = await findRunningGateway({ port: this.port, key: this.apiKey, timeoutMs });
    if (!found) return false;
    this.#setPort(found.port);
    this.apiKey = found.apiKey;
    // A gateway no state file vouches for was started by an older OmniWork:
    // keyless, logging prompts. Say so rather than inherit it silently.
    if (!found.recorded && !this._warnedLegacy) {
      this._warnedLegacy = true;
      this.status("boot", "Using a gateway started by an older OmniWork — it doesn't require a key and may log prompts. Quit OmniWork everywhere and restart to apply current settings.");
    }
    if (found.dataDir) tightenTree(found.dataDir);
    return true;
  }

  // Something already holds the port. Give it a chance to be a gateway that was
  // simply slower to come up than the 2s startup probe allowed.
  async #probePatiently(budgetMs) {
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      if (this._stopped) return false;
      if (await this.#adoptRunning(3000)) return true;
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
    let omniDir = this.omniDirOverride || resolveBundledOmniroute();
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

    // OmniRoute keeps its store and logs here. Per-user app data dir, owner-only.
    const gwDataDir = path.join(this.dataDir, "omniroute");
    fs.mkdirSync(gwDataDir, { recursive: true });
    tightenTree(gwDataDir);

    // Nobody healthy answered above, so if we also cannot bind the port then
    // something is sitting on it without serving — a gateway wedged by an
    // earlier hard kill, usually. Spawning into that just dies on EADDRINUSE,
    // and every later launch dies the same way until someone finds the process
    // by hand. Two outs, in order of preference.
    if (!(await portAvailable(this.port))) {
      this.status("boot", "Port in use — looking for a healthy gateway…");
      // It may simply have been slower to boot than the 2s startup probe.
      if (await this.#probePatiently(this.patienceMs)) {
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

    // An explicit environment (child-env.js), not the user's shell: the
    // gateway has no use for their tokens, and must not pick up settings like
    // CORS_ALLOW_ALL meant for something else.
    // Logging: OmniRoute writes every request's full prompt and reply to
    // call_logs/ unless the key it came through is marked no-log — so the
    // per-install key is. OMNIWORK_GATEWAY_LOGS=on keeps the bodies (owner-
    // only, a day's retention). The defaults come first so a passed-through
    // variable can tune them; the settings after gatewayEnv() can't be.
    const keepBodies = /^(1|true|yes|on)$/i.test(process.env.OMNIWORK_GATEWAY_LOGS || "");
    const env = {
      APP_LOG_TO_FILE: "false",
      CALL_LOG_RETENTION_DAYS: "1",
      // Don't present the gateway as OpenCode's own client (see blockKeylessOpenCode).
      OPENCODE_SYNTHESIZE_CLI_HEADERS: "false",
      ...gatewayEnv(),
      ...(keepBodies ? {} : { NO_LOG_API_KEY_IDS: "env-key" }),
      NODE_ENV: "production",
      PORT: String(this.port), // may differ from PORT if the well-known one was blocked
      HOSTNAME: HOST, // bind loopback only
      DATA_DIR: gwDataDir, // OmniRoute reads DATA_DIR for its storage + .env
      // Keep free auto routes from widening to paid candidates when empty.
      OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL: "false",
      // Skip outbound startup syncs — faster, quieter, works offline.
      ARENA_ELO_SYNC_ENABLED: "false",
      PRICING_SYNC_ENABLED: "false",
      // Only OmniWork's own clients: every request needs the per-install key.
      // OMNIWORK_GATEWAY_OPEN=1 keeps the keyless gateway for one release.
      OMNIROUTE_API_KEY: this.apiKey,
      REQUIRE_API_KEY: /^(1|true|yes|on)$/i.test(process.env.OMNIWORK_GATEWAY_OPEN || "") ? "false" : "true",
      // Extra Host names the guard accepts (e.g. host.docker.internal).
      OMNIWORK_GATEWAY_ALLOWED_HOSTS: process.env.OMNIWORK_GATEWAY_ALLOWED_HOSTS || "",
    };
    const guard = installGuard(this.dataDir);

    // Corrupt gateway storage (e.g. after a hard kill) makes the server listen
    // but never turn healthy. If the first boot fails, set the database aside
    // only when SQLite itself says it is corrupt; otherwise retry once with the
    // storage untouched. Either way it is one retry, as before.
    protectBackups(gwDataDir);
    for (let attempt = 0; ; attempt++) {
      // stop() may have landed while we were awaiting above (the watchdog can be
      // mid-restart when the app quits). Spawning now would strand a gateway on
      // the port with nobody left to kill it.
      if (this._stopped) throw new Error("gateway start aborted by shutdown");
      this.#spawnServer(serverEntry, omniDir, env, guard);
      try {
        await this.#waitHealthy();
        if (this._stopped) { this.#killProc(); throw new Error("gateway start aborted by shutdown"); }
        try {
          writePrivate(stateFile(), JSON.stringify({ version: 1, port: this.port, pid: this.proc.pid, ownerPid: process.pid, key: this.apiKey, dataDir: gwDataDir, startedAt: new Date().toISOString() }));
        } catch (e) { this.status("boot", `Could not record the gateway for other OmniWork processes: ${e.message}`); }
        try { await blockKeylessOpenCode(this.baseUrl, this.apiKey, gwDataDir); }
        catch (e) { this.status("boot", `Could not turn off keyless OpenCode routing: ${e.message}`); }

        this.#watchdog();
        return this.baseUrl;
      } catch (e) {
        // #killProc, not stop(): this is a retry, not a shutdown, so it must not
        // latch the abort flag that stop() sets.
        await this.#killProc({ wait: true });
        const db = path.join(gwDataDir, STORAGE);
        if (this._stopped || attempt > 0) throw e;
        if (fs.existsSync(db) && (await checkStorage(db, this.nodeBinary)) === "corrupt") {
          const backup = quarantineStorage(gwDataDir);
          this.storageReset = { at: new Date().toISOString(), backup };
          this.notice = `Gateway storage was corrupt and has been reset — reconnect your providers. The old database is at ${backup}.`;
          this.status("boot", this.notice);
        } else {
          this.status("boot", "Gateway was slow to start — retrying…");
        }
      }
    }
  }

  #spawnServer(serverEntry, omniDir, env, guard) {
    this._exited = false;
    // Never pipe to us in normal runs: the gateway is meant to outlive this
    // process (see #adoptRunning), and a detached child writing to a pipe whose
    // reader has exited takes EPIPE and dies. So /dev/null by default.
    //
    // In DEV we still want the output. We used to inherit a raw fd into the
    // child's stdio and fs.closeSync it right after spawn — but on Windows that
    // double-owned handle aborts the whole process with a libuv assertion
    // (UV_HANDLE_CLOSING, async.c). Pipe to an append stream instead: Node owns
    // the handles, nothing is force-closed, and errors on the pipe are swallowed.
    const dev = !!process.env.OMNIWORK_DEV;
    const stdio = dev ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"];

    // detached: gives the child its own process group so stop() can take down
    // any workers Next.js spawned, not just the parent.
    this.proc = spawn(this.nodeBinary, ["--require", guard, serverEntry], {
      cwd: path.join(omniDir, "dist"),
      env,
      stdio,
      detached: process.platform !== "win32",
    });

    if (dev && this.proc.stdout) {
      try {
        const ws = fs.createWriteStream(path.join(this.dataDir, "omniroute-sidecar.log"), { flags: "a" });
        ws.on("error", () => {});
        this.proc.stdout.on("error", () => {});
        this.proc.stderr.on("error", () => {});
        this.proc.stdout.pipe(ws);
        this.proc.stderr.pipe(ws);
      } catch { /* logging is best-effort */ }
    }

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

  async #waitHealthy(timeoutMs = this.healthTimeoutMs) {
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
        const left = timeoutMs - (Date.now() - started);
        const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, Math.min(5000, left))) });
        if (res.ok || res.status === 401) {
          this.ready = true;
          this.status("ready", this.notice ? "OmniRoute · free models · storage was reset — reconnect providers" : "OmniRoute · free models");
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
    // The state file names our process: other OmniWork processes must not try it.
    const pid = !this.adopted && this.proc ? this.proc.pid : null;
    if (pid && readGatewayState()?.pid === pid) { try { fs.rmSync(stateFile(), { force: true }); } catch {} }
    this.#killProc();
  }

  // Tear down the child process without signalling shutdown intent, so start()
  // can reuse it between retry attempts. `wait` resolves once it has exited
  // (or the SIGKILL grace has passed): a retry that spawns while the old
  // process still holds the port or the database races it.
  #killProc({ wait = false } = {}) {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    // We adopted someone else's gateway — leave it running for its owner.
    if (this.adopted || !proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    const exited = new Promise((resolve) => proc.once("exit", resolve));

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
    return wait ? Promise.race([exited, sleep(4000)]) : Promise.resolve();
  }
}

module.exports = { Gateway, PORT, BASE_URL, probeGateway, portAvailable, freePort, checkStorage, quarantineStorage, storageBackups, findRunningGateway, readGatewayState, ensureApiKey };
