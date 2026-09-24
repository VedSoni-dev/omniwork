"use strict";
// OpenCode as an engine inside OmniWork.
//
// OpenCode Zen's free models (Nemotron 3 Ultra, Nemotron 3.5 Lightning,
// MiMo V2.5, Ling 3.0 Flash, Big Pickle…) are real, keyless, tool-capable, and
// generous — and Zen refuses them to anything that isn't OpenCode ("OpenCode's
// free tier can only be used in OpenCode"). We don't fake being OpenCode; we
// run it. `opencode serve` is the headless server OpenCode ships for exactly
// this — Zed and acpx drive it the same way — and its sessions do the work on
// those models with OpenCode's own tools, scoped to our workspace through the
// `x-opencode-directory` header the official SDK uses.
//
// One server per OmniWork process, started on first use, killed on exit.
// `OpenCodeAgent` wraps a server session in the same interface `Agent` has, so
// the desktop app, the MCP server, and the ACP server can run a session on
// `opencode/<model>` without knowing the difference.

const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROVIDER_IDS = ["opencode", "opencode-go"];
const PREFIX = "opencode/";
const workerProfile = require("./engine-profile");

// ── locating / getting the binary ────────────────────────────────
// Nobody should have to touch their PATH. The binary is looked for where each
// way of getting OmniWork puts it, and spawned by absolute path:
//   1. OMNIWORK_OPENCODE_BIN                 an explicit override
//   2. <app>/resources/runtime/opencode      the packaged desktop app (staged per platform at build time)
//   3. node_modules/opencode-<os>-<arch>     a clone after `npm install` (opencode-ai is an optional dependency)
//   4. ~/.omniwork/engine/opencode           downloaded on first use from OpenCode's GitHub release
//   5. ~/.opencode/bin, npm's global bin, Homebrew, and the PATH — an install the user already has
const REPO_ROOT = path.join(__dirname, "..");
const DOWNLOAD_DIR = path.join(os.homedir(), ".omniwork", "engine", "opencode");
const RELEASES = "https://github.com/anomalyco/opencode/releases/download";

function target() {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return { platform, arch };
}
const exeName = () => (process.platform === "win32" ? "opencode.exe" : "opencode");

function candidates() {
  const exe = exeName();
  const { platform, arch } = target();
  const list = [];
  if (process.env.OMNIWORK_OPENCODE_BIN) list.push(process.env.OMNIWORK_OPENCODE_BIN);
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, "runtime", "opencode", exe));
  const pkg = `opencode-${platform}-${arch}`;
  for (const root of [REPO_ROOT, path.join(REPO_ROOT, "node_modules", "opencode-ai")]) {
    list.push(path.join(root, "node_modules", pkg, "bin", exe));
    list.push(path.join(root, "node_modules", `${pkg}-baseline`, "bin", exe));
  }
  list.push(path.join(REPO_ROOT, "node_modules", "opencode-ai", "bin", "opencode.exe")); // the package's postinstall copy (that name on every OS)
  list.push(path.join(DOWNLOAD_DIR, exe));
  const npmPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  list.push(
    path.join(os.homedir(), ".opencode", "bin", exe),
    "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode",
    path.join(os.homedir(), ".bun", "bin", exe),
    path.join(os.homedir(), ".npm-global", "bin", exe),
    path.join(os.homedir(), ".npm", "bin", exe),
    ...(npmPrefix ? [path.join(npmPrefix, "bin", exe)] : []),
    ...(process.platform === "win32" ? [path.join(process.env.APPDATA || "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")] : []),
  );
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) if (dir) list.push(path.join(dir, exe));
  return list;
}

function findBinary() {
  for (const c of candidates()) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
  return null;
}
const available = () => Boolean(findBinary());

// The version OmniWork ships and downloads: whatever package.json pins for
// opencode-ai, so a clone and a download agree.
function pinnedVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const v = (pkg.optionalDependencies || {})["opencode-ai"] || (pkg.dependencies || {})["opencode-ai"] || "";
    return v.replace(/^[^0-9]*/, "") || "1.18.31";
  } catch { return "1.18.31"; }
}
function platformPackage(t = target()) { return `opencode-${t.platform}-${t.arch}`; }
const exeFor = (pkg) => (pkg.includes("windows") ? "opencode.exe" : "opencode");

// The download is verified against the sha512 npm recorded for that package in
// package-lock.json — a hash that ships with the repo, pinned with the version.
// OpenCode's GitHub releases publish no checksums; the npm registry tarball of
// the same binary comes with one. This is the only download path.
function lockEntry(pkg) {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  const e = lock.packages && lock.packages[`node_modules/${pkg}`];
  if (!e || !e.integrity || !e.resolved) throw new Error(`package-lock.json has no pinned integrity for ${pkg} — run npm install to refresh it`);
  return { integrity: e.integrity, resolved: e.resolved, version: e.version };
}
const INSTALL_COMMAND = "npm run providers connect opencode";
const INSTALL_SCRIPT = "curl -fsSL https://opencode.ai/install | bash";

function version() {
  const bin = findBinary();
  if (!bin) return null;
  try { return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim().split("\n").pop(); }
  catch { return "installed"; }
}

// Fetch the platform package (~45 MB) into `dir`, verify its hash, unpack just
// the binary. Only ever run from an explicit user gesture — a click, a typed
// command, an ACP auth method — never a tool call.
async function download({ pkg = platformPackage(), dir = DOWNLOAD_DIR, entry = null, onProgress = () => {} } = {}) {
  const { Readable, Transform } = require("node:stream");
  const { pipeline } = require("node:stream/promises");
  const tar = require("tar");
  const { integrity, resolved: url, version: ver } = entry || lockEntry(pkg);
  const [algo, expected] = String(integrity).split("-", 2);
  if (!/^sha(256|384|512)$/.test(algo) || !expected) throw new Error(`unusable integrity string for ${pkg}`);
  const exe = exeFor(pkg);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `${pkg}.tgz`);
  onProgress({ phase: "download", detail: `Downloading OpenCode v${ver} (${pkg})…`, url });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`OpenCode download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const hash = crypto.createHash(algo);
  const meter = new Transform({ transform(chunk, _enc, cb) { received += chunk.length; hash.update(chunk); onProgress({ phase: "download", received, total }); cb(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(archive + ".part"));
    const digest = hash.digest("base64");
    if (digest !== expected) throw new Error(`OpenCode download failed integrity check (${algo} mismatch for ${pkg}) — not installed`);
    fs.renameSync(archive + ".part", archive);
    onProgress({ phase: "extract", detail: "Verified. Unpacking…" });
    const want = new RegExp(`^package/bin/${exe.replace(".", "\\.")}$`);
    await tar.x({ file: archive, cwd: dir, strip: 2, filter: (p) => want.test(p) });
  } finally {
    fs.rmSync(archive + ".part", { force: true });
    fs.rmSync(archive, { force: true });
  }
  const bin = path.join(dir, exe);
  if (!fs.existsSync(bin)) throw new Error(`OpenCode package unpacked but ${bin} is missing`);
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  if (pkg === platformPackage()) {
    const v = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim().split("\n").pop();
    onProgress({ phase: "done", detail: `OpenCode ${v} ready` });
  } else {
    onProgress({ phase: "done", detail: `OpenCode ${ver} (${pkg}) staged` });
  }
  return bin;
}

// One entry point every surface calls; concurrent callers share one download.
let installing = null;
async function install({ log = () => {} } = {}) {
  const found = findBinary();
  if (found) return found;
  if (installing) return installing;
  let lastPct = -1;
  installing = download({ onProgress: (p) => {
    if (p.detail) log(p.detail);
    else if (p.total) { const pct = Math.floor((p.received / p.total) * 100); if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; log(`${pct}%`); } }
  } });
  try { return await installing; }
  finally { installing = null; }
}

// ── the server ────────────────────────────────────────────────────
class Engine {
  constructor({ bin = findBinary(), log = () => {} } = {}) {
    this.bin = bin;
    this.log = log;
    this.proc = null;
    this.baseUrl = null;
    this.starting = null;
    this.listeners = new Map(); // sessionID -> Set<fn(event)>
    this.pumps = new Map();      // directory -> { ctl, refs, ready } for its event stream
    this.modelsCache = { at: 0, list: [] };
    // Loopback is not an authorization boundary: the server only answers
    // requests carrying this per-process secret (OpenCode's own basic auth).
    this.username = "omniwork";
    this.password = crypto.randomBytes(24).toString("hex");
  }

  async start() {
    if (this.baseUrl) return this.baseUrl;
    if (this.starting) return this.starting;
    if (!this.bin) throw new Error(`OpenCode is not installed — run: ${INSTALL_COMMAND}`);
    this.starting = new Promise((resolve, reject) => {
      // OpenCode snapshots the whole session directory with `git add --all`
      // before every message so its UI can revert. Scoped to a home folder that
      // is three minutes per turn (measured: 174 s → 4 s without). OmniWork has
      // its own undo, so engine sessions run with snapshots off — merged into
      // any config the user already passes by env.
      let extra = { snapshot: false };
      if (process.env.OPENCODE_CONFIG_CONTENT) { try { extra = { ...JSON.parse(process.env.OPENCODE_CONFIG_CONTENT), ...extra }; } catch {} }
      extra.agent = { ...(extra.agent || {}), [workerProfile.NAME]: workerProfile.config(), [workerProfile.SCOPED_NAME]: workerProfile.config({ compact: false }) };
      const env = {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_TERMINAL_TITLE: "1",
        OPENCODE_DISABLE_PRUNE: "1",
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(extra),
        OPENCODE_SERVER_USERNAME: this.username,
        OPENCODE_SERVER_PASSWORD: this.password,
      };
      // A neutral cwd: the workspace comes per request, never from where we
      // happened to start.
      const proc = spawn(this.bin, ["serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
      this.proc = proc;
      let buf = "";
      const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("opencode serve did not report a port within 60s")); }, 60_000);
      const onLine = (line) => {
        const m = /listening on (http:\/\/[^\s]+)/.exec(line);
        if (m && !this.baseUrl) {
          this.baseUrl = m[1].replace(/\/$/, "");
          clearTimeout(timer);
          resolve(this.baseUrl);
        } else if (/error/i.test(line)) this.log("[opencode]", line.slice(0, 200));
      };
      const feed = (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
      proc.stdout.on("data", feed);
      proc.stderr.on("data", feed);
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (this.proc !== proc) return; // a server we already replaced
        const was = this.baseUrl;
        this.baseUrl = null; this.proc = null; this.starting = null;
        for (const p of this.pumps.values()) p.ctl.abort();
        this.pumps.clear();
        if (!was) reject(new Error(`opencode serve exited with ${code} before listening`));
        else this.log("[opencode] server exited", code);
      });
    });
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch {} }
    this.proc = null; this.baseUrl = null;
    for (const p of this.pumps.values()) p.ctl.abort();
    this.pumps.clear();
  }

  #auth() { return "Basic " + Buffer.from(`${this.username}:${this.password}`).toString("base64"); }

  async #req(method, p, { body, directory, timeoutMs = 30_000, signal } = {}) {
    const base = await this.start();
    const headers = { "Content-Type": "application/json", Authorization: this.#auth() };
    if (directory) headers["x-opencode-directory"] = encodeURIComponent(directory);
    const res = await fetch(base + p, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      // A prompt runs as long as the task takes; everything else gets a deadline.
      signal: signal || (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined),
    });
    const text = await res.text().catch(() => "");
    let json = null; try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`opencode ${method} ${p}: ${res.status} ${(json && json.error && (json.error.message || json.error.type)) || text.slice(0, 200)}`);
    return json;
  }

  // OpenCode's event stream is scoped to a directory — without the header it
  // carries only server heartbeats — so there is one subscription per
  // workspace, fanned out per session, kept alive for the life of the server.
  async #pump(directory, ctl, onConnected) {
    const base = this.baseUrl;
    while (this.baseUrl === base && !ctl.signal.aborted) {
      try {
        const res = await fetch(`${base}/event`, { signal: ctl.signal, headers: { Accept: "text/event-stream", Authorization: this.#auth(), "x-opencode-directory": encodeURIComponent(directory) } });
        if (onConnected) { onConnected(); onConnected = null; }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue;
              let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
              const sid = ev?.properties?.sessionID || ev?.properties?.part?.sessionID || ev?.properties?.info?.sessionID;
              const set = sid && this.listeners.get(sid);
              if (set) for (const fn of set) { try { fn(ev); } catch {} }
            }
          }
        }
      } catch {}
      if (this.baseUrl === base && !ctl.signal.aborted) await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Make sure the workspace's event stream is connected before a prompt goes
  // out — the first tool part can arrive within milliseconds.
  // Streams are ref-counted per workspace: the last subscriber leaving closes
  // the connection, so a long-lived server that has touched many workspaces
  // holds no idle sockets.
  ensurePump(directory) {
    if (!this.pumps.has(directory)) {
      const ctl = new AbortController();
      const ready = new Promise((resolve) => { this.#pump(directory, ctl, resolve); setTimeout(resolve, 3000); });
      this.pumps.set(directory, { ctl, refs: 0, ready });
    }
    return this.pumps.get(directory).ready;
  }

  subscribe(sessionID, fn, directory) {
    if (!this.listeners.has(sessionID)) this.listeners.set(sessionID, new Set());
    this.listeners.get(sessionID).add(fn);
    const pump = directory ? this.pumps.get(directory) : null;
    if (pump) pump.refs++;
    return () => {
      const s = this.listeners.get(sessionID);
      if (s) { s.delete(fn); if (!s.size) this.listeners.delete(sessionID); }
      if (pump && --pump.refs <= 0 && this.pumps.get(directory) === pump) { pump.ctl.abort(); this.pumps.delete(directory); }
    };
  }

  async health() { return await this.#req("GET", "/global/health", { timeoutMs: 5000 }); }

  // Free models on OpenCode's own providers: `opencode/<id>` in OmniWork terms.
  async models({ force = false } = {}) {
    if (!force && Date.now() - this.modelsCache.at < 300_000) return this.modelsCache.list;
    const data = await this.#req("GET", "/provider", { timeoutMs: 20_000 });
    const list = [];
    const connected = new Set(data?.connected || []);
    for (const prov of (data && data.all) || []) {
      const builtIn = PROVIDER_IDS.includes(prov.id);
      if (!builtIn && !connected.has(prov.id)) continue;
      for (const [id, m] of Object.entries(prov.models || {})) {
        const cost = m && m.cost;
        const free = cost && cost.input != null && cost.output != null && Number(cost.input) === 0 && Number(cost.output) === 0;
        if (!free && !connected.has(prov.id)) continue;
        if (m.status === "deprecated") continue;
        const route = builtIn && free ? `${PREFIX}${id}` : `${PREFIX}${prov.id}/${id}`;
        list.push({ id: route, providerID: prov.id, modelID: id, name: m.name || id, tools: typeof m.tool_call === "boolean" ? m.tool_call : null, context: m.limit && m.limit.context, free: Boolean(free), cost: cost || null, access: free && builtIn ? "no account" : "connected account", source: "OpenCode" });
      }
    }
    // Strongest coders first: Nemotron Ultra, then the rest in catalog order.
    list.sort((a, b) => Number(b.free) - Number(a.free) || rank(a.modelID) - rank(b.modelID));
    this.modelsCache = { at: Date.now(), list };
    return list;
  }

  async createSession({ directory, title, permission }) {
    const body = { title };
    if (permission) body.permission = permission;
    const s = await this.#req("POST", "/session", { body, directory });
    return s.id;
  }
  async prompt(sessionID, { directory, providerID, modelID, text, signal, agent }) {
    return await this.#req("POST", `/session/${sessionID}/message`, {
      body: { model: { providerID, modelID }, ...(agent ? { agent } : {}), parts: [{ type: "text", text }] },
      directory, signal, timeoutMs: 0,
    });
  }
  async abort(sessionID, directory) { return await this.#req("POST", `/session/${sessionID}/abort`, { directory, timeoutMs: 5000 }).catch(() => false); }
  async replyPermission(sessionID, permissionID, response, directory) {
    return await this.#req("POST", `/session/${sessionID}/permissions/${permissionID}`, { body: { response }, directory, timeoutMs: 5000 });
  }
  async diff(sessionID, directory) { return await this.#req("GET", `/session/${sessionID}/diff`, { directory, timeoutMs: 10_000 }).catch(() => []); }
}

// Measured 2026-09-15 on a one-line reply: Lightning 4s, MiMo 5s, Big Pickle
// 6s, Ling 3s, Ultra ~100s per step. Ultra is the strongest and stays
// available by name; the default has to answer in seconds.
const RANK = ["nemotron-3.5-lightning", "mimo-v2.5", "big-pickle", "ling-3.0-flash", "nemotron-3-ultra"];
function rank(id) { const i = RANK.findIndex((r) => id.startsWith(r)); return i < 0 ? RANK.length : i; }

// The server must not outlive the process that started it. `exit` covers a
// normal end; a SIGTERM/SIGINT (a harness killing its agent, Ctrl-C) skips the
// exit hook unless we turn it into one.
let shared = null;
function getEngine(opts) {
  if (!shared) {
    shared = new Engine(opts);
    process.on("exit", () => shared && shared.stop());
    // Electron's app.quit path runs "exit" itself; a raw signal handler there
    // would skip its cleanup. Headless servers get one that exits the way the
    // shell expects (128 + signal number).
    if (!process.versions.electron) {
      const codes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      for (const sig of Object.keys(codes)) {
        if (process.listenerCount(sig) === 0) process.on(sig, () => { if (shared) shared.stop(); process.exit(codes[sig]); });
      }
    }
  }
  return shared;
}

// ── the agent ─────────────────────────────────────────────────────
// Same surface as electron/agent.js's Agent, backed by an OpenCode session.
// Events map one-to-one: text deltas → assistant_delta, tool parts →
// tool_call / tool_result, permission requests → the approver, session errors
// → error. What OmniWork can't offer here is its own skills and memory —
// OpenCode runs its own tools — which is the honest price of the free tier.
class OpenCodeAgent {
  constructor({ model, workspace, emit, approvalMode = "auto", approver = null, engine = getEngine(), fallbackModels = [], messages = null, sessionID = null, engineProfile = "standard" }) {
    this.engine = engine;
    if (!["standard", "focused", "scoped"].includes(engineProfile)) throw new Error("Unknown engine profile");
    this.engineProfile = engineProfile;
    this.model = model || `${PREFIX}nemotron-3.5-lightning-free`;
    this.fallbackModels = fallbackModels; // accepted for interface parity; the engine picks its own
    this.workspace = workspace;
    this.emit = emit;
    this.approvalMode = approvalMode;
    this.approver = approver;
    // A conversation handed over from another agent is carried into the first
    // prompt, so a mid-session switch does not forget what was said.
    this.messages = Array.isArray(messages) && messages.length ? messages.slice() : [{ role: "system", content: "(OpenCode engine session)" }];
    this.carryOver = !sessionID && this.messages.some((m) => m.role === "user");
    this.lastText = "";
    this.modelSwitches = [];
    this.contextTokens = 200_000;
    this.memory = null;
    this.sessionID = sessionID || null; // OpenCode's own id — persisted by callers that resume sessions
    this.aborted = false;
    this.undoAvailable = false;
    this.turnStats = null;
  }

  get isEngine() { return true; }
  setWorkspace(dir) { this.workspace = dir; this.sessionID = null; }
  abort() { this.aborted = true; this.abortCtl?.abort(); if (this.sessionID) this.engine.abort(this.sessionID, this.workspace); }
  setModel(model) { this.model = model; this.contextTokens = this.engine.modelsCache.list.find(m => m.id === model)?.context || 200_000; }
  async compactNow() { return null; }
  async oneShot(prompt) {
    const { providerID, modelID } = this.#target();
    const sid = await this.engine.createSession({ directory: this.workspace, title: "oneshot", permission: [{ permission: "*", pattern: "*", action: "deny" }] });
    const res = await this.engine.prompt(sid, { directory: this.workspace, providerID, modelID, text: prompt });
    return textOf(res);
  }
  undo() { return "Undo isn't available for OpenCode engine sessions — use git."; }

  #target() {
    const id = this.model.startsWith(PREFIX) ? this.model.slice(PREFIX.length) : this.model;
    // opencode-go models are namespaced by the engine's provider list; default provider is Zen.
    const cached = this.engine.modelsCache.list.find((m) => m.id === this.model);
    if (cached) return { providerID: cached.providerID, modelID: cached.modelID };
    const slash = id.indexOf("/");
    return slash > 0 ? { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) } : { providerID: "opencode", modelID: id };
  }

  // OpenCode's per-session ruleset: an ordered list of {permission, pattern,
  // action}, mirroring OmniWork's approval modes.
  #permission() {
    if (this.engineProfile !== "standard") return workerProfile.permissions(this.approvalMode);
    const rule = (permission, action) => ({ permission, pattern: "*", action });
    if (this.approvalMode === "auto") return [rule("*", "allow")];
    if (this.approvalMode === "plan") return [rule("*", "ask"), rule("read", "allow"), rule("edit", "deny"), rule("write", "deny"), rule("bash", "deny")];
    if (this.approvalMode === "edits") return [rule("*", "ask"), rule("read", "allow"), rule("edit", "allow"), rule("write", "allow")];
    return [rule("*", "ask"), rule("read", "allow")];
  }

  async send(userText, images) {
    this.aborted = false;
    this.lastText = "";
    this.abortCtl = new AbortController();
    this.turnStats = { startedAt: Date.now(), inTokens: 0, outTokens: 0, estimated: true };
    let text = images && images.length ? `${userText}\n\n(${images.length} image(s) attached — not forwarded to the OpenCode engine)` : userText;
    if (this.carryOver) { text = carriedContext(this.messages) + text; this.carryOver = false; }
    this.messages.push({ role: "user", content: userText });
    this.emit("thinking", { step: 0 });

    // The model's provider (Zen vs Go) comes from the catalog; make sure it is loaded.
    if (!this.engine.modelsCache.list.length) { try { await this.engine.models(); } catch {} }
    const { providerID, modelID } = this.#target();
    let unsubscribe = () => {};
    let streamedText = "";
    const partType = new Map();  // partID -> "text" | "reasoning" | …  (deltas don't say)
    const held = new Map();      // partID -> delta text that arrived before the part's type
    const seen = new Map();      // callID -> "called" | "done"
    const usageByMessage = new Map();
    const recordUsage = (id, tokens) => {
      if (!id || !Number.isFinite(tokens?.input) || !Number.isFinite(tokens?.output)) return;
      usageByMessage.set(id, tokens);
      let input = 0, output = 0, uncached = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0;
      for (const t of usageByMessage.values()) {
        uncached += t.input; cacheRead += t.cache?.read || 0; cacheWrite += t.cache?.write || 0; reasoning += t.reasoning || 0;
        input += t.input + (t.cache?.read || 0) + (t.cache?.write || 0);
        output += t.output + (t.reasoning || 0);
      }
      this.turnStats = { ...this.turnStats, inTokens: input, outTokens: output, uncachedInTokens: uncached, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: reasoning, modelRequests: usageByMessage.size, estimated: false };
      this.emit("stats", this.#stats());
    };
    const flush = (partID, type, delta) => {
      if (type === "text") { streamedText += delta; this.emit("assistant_delta", { chunk: delta }); }
      else if (type === "reasoning") this.emit("reasoning_delta", { chunk: delta });
    };
    try {
      if (!this.sessionID) this.sessionID = await this.engine.createSession({ directory: this.workspace, title: `OmniWork · ${path.basename(this.workspace || "")}`, permission: this.#permission() });
      const sid = this.sessionID;
      await this.engine.ensurePump(this.workspace);
      unsubscribe = this.engine.subscribe(sid, (ev) => {
        const p = ev.properties || {};
        switch (ev.type) {
          case "message.updated":
            if (p.info?.role === "assistant") recordUsage(p.info.id, p.info.tokens);
            break;
          // A delta only names its part; the part's type came (or comes) with a
          // message.part.updated. Reasoning streams on field "text" too, so a
          // delta is held until its part is known and never mistaken for the reply.
          case "message.part.delta": {
            if (p.field !== "text" || !p.delta) break;
            const type = partType.get(p.partID);
            if (type) flush(p.partID, type, p.delta);
            else held.set(p.partID, (held.get(p.partID) || "") + p.delta);
            break;
          }
          case "message.part.updated": {
            const part = p.part || {};
            if (part.type === "step-finish") recordUsage(part.messageID, part.tokens);
            if (part.id && part.type && !partType.has(part.id)) {
              partType.set(part.id, part.type);
              if (held.has(part.id)) { flush(part.id, part.type, held.get(part.id)); held.delete(part.id); }
            }
            if (part.type !== "tool") break;
            const st = part.state || {};
            const id = part.callID || part.id;
            // Tool input streams in; announce the call once its arguments exist
            // (or it finished), never with an empty object.
            const hasInput = st.input && Object.keys(st.input).length > 0;
            if (!seen.has(id) && (hasInput || st.status === "completed" || st.status === "error")) {
              seen.set(id, "called");
              this.emit("tool_call", { id, name: part.tool, args: st.input || {} });
            }
            if (seen.get(id) === "called" && (st.status === "completed" || st.status === "error")) {
              seen.set(id, "done");
              this.emit("tool_result", { id, name: part.tool, ok: st.status === "completed", result: st.status === "error" ? `Error in ${part.tool}: ${st.error || "failed"}` : String(st.output ?? st.title ?? "") });
            }
            break;
          }
          case "permission.asked":
            this.#onPermission(sid, p);
            break;
          case "session.error":
            this.emit("system", { content: `OpenCode: ${(p.error && (p.error.data && p.error.data.message || p.error.name)) || "error"}` });
            break;
        }
      }, this.workspace);

      const res = await this.engine.prompt(sid, { directory: this.workspace, providerID, modelID, text, signal: this.abortCtl.signal, agent: this.engineProfile === "scoped" ? workerProfile.SCOPED_NAME : this.engineProfile === "focused" ? workerProfile.NAME : undefined });
      recordUsage(res?.info?.id, res?.info?.tokens);
      if (this.aborted) { this.emit("aborted", this.#stats()); return; }
      const err = res && res.info && res.info.error;
      if (err) {
        const msg = (err.data && err.data.message) || err.name || "OpenCode session error";
        this.emit("error", { message: `OpenCode (${modelID}): ${msg}` });
        return;
      }
      const out = textOf(res);
      this.lastText = out;
      this.messages.push({ role: "assistant", content: out });
      // Clients that render only the stream (ACP) must still see the whole
      // answer when the event feed lagged behind the response.
      if (out && !streamedText) this.emit("assistant_delta", { chunk: out });
      else if (out && out.startsWith(streamedText) && out.length > streamedText.length) this.emit("assistant_delta", { chunk: out.slice(streamedText.length) });
      if (out) this.emit("assistant", { content: out });
      this.emit("done", this.#stats());
    } catch (e) {
      if (this.aborted) { this.emit("aborted", this.#stats()); return; }
      this.emit("error", { message: e.message });
    } finally {
      unsubscribe();
    }
  }

  async #onPermission(sid, p) {
    let response = "reject";
    try {
      if (this.approvalMode === "auto") response = "once";
      else if (this.approver) {
        const name = p.permission || "tool";
        const args = { ...(p.metadata || {}), patterns: p.patterns };
        response = (await this.approver(p.id, name, args, null)) ? "once" : "reject";
      }
    } catch {}
    await this.engine.replyPermission(sid, p.id, response, this.workspace).catch(() => {});
  }

  #stats() { const s = this.turnStats; return s ? { elapsedMs: Date.now() - s.startedAt, inTokens: s.estimated ? null : s.inTokens, outTokens: s.estimated ? null : s.outTokens, ...(s.estimated ? {} : Object.fromEntries(["uncachedInTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "modelRequests"].map(k => [k, s[k]]))), estimated: s.estimated } : {}; }

  async runSubagents() { return "Subagents aren't available on the OpenCode engine — delegate the pieces separately."; }
  loadProjectMemory() { return ""; }
}

// The last turns of a conversation another model handled, as a preface for
// the engine's first prompt. Bounded so a long session does not become the
// whole prompt.
function carriedContext(messages, { turns = 20, perMessage = 600, total = 8000 } = {}) {
  const recent = messages.filter((m) => m.role === "user" || m.role === "assistant").slice(-turns);
  const lines = [];
  let size = 0;
  for (const m of recent) {
    const body = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n") : "";
    const line = `${m.role === "user" ? "User" : "Assistant"}: ${String(body).replace(/\s+/g, " ").trim().slice(0, perMessage)}`;
    if (size + line.length > total) break;
    lines.push(line); size += line.length;
  }
  if (!lines.length) return "";
  return `Context — this conversation was handled by another model until now. Recent turns:\n${lines.join("\n")}\n\nContinue from here. New message:\n`;
}

function textOf(res) {
  const parts = (res && res.parts) || [];
  return parts.filter((p) => p && p.type === "text" && !p.synthetic).map((p) => p.text || "").join("").trim();
}

const isEngineModel = (id) => typeof id === "string" && id.startsWith(PREFIX);

module.exports = { PREFIX, findBinary, candidates, available, version, install, download, lockEntry, platformPackage, pinnedVersion, target, DOWNLOAD_DIR, INSTALL_COMMAND, INSTALL_SCRIPT, Engine, getEngine, OpenCodeAgent, isEngineModel };
