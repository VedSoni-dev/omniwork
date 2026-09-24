"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const os = require("node:os");
function dataDir() {
  if (process.env.OMNIWORK_DATA_DIR) return path.resolve(process.env.OMNIWORK_DATA_DIR);
  const home = os.homedir();
  return process.platform === "darwin" ? path.join(home, "Library", "Application Support", "omniwork") : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "omniwork") : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "omniwork");
}
function configId() {
  return crypto.createHash("sha256").update(JSON.stringify([process.env.OMNIWORK_BASE_URL || "", process.env.OMNIWORK_API_KEY || "", process.env.OMNIWORK_OPENCODE_BIN || "", process.env.OPENCODE_CONFIG_CONTENT || ""])).digest("hex");
}
function location() { return path.join(dataDir(), "jobs"); }
function descriptor() { try { return JSON.parse(fs.readFileSync(path.join(location(), "service.json"), "utf8")); } catch { return null; } }
async function request(endpoint, method, args = {}, { signal, timeout = 30000 } = {}) {
  if (endpoint.version !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error("Invalid worker service descriptor");
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify({ method, args }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Worker service HTTP ${response.status}`);
  return result;
}
let connecting;
async function ensure() {
  if (connecting) return connecting;
  connecting = (async () => {
    let old = descriptor();
    if (old) {
      const live = await request(old, "health", {}, { timeout: 1000 }).catch(() => null);
      if (live) {
        if (old.configId !== configId()) throw new Error("The worker service is running with different provider settings. Stop it explicitly with omniwork-jobs stop before changing settings.");
        return old;
      }
    }
    fs.mkdirSync(location(), { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(location(), "service.log"), "a", 0o600);
    const child = spawn(process.execPath, [path.join(__dirname, "job-daemon.js")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
    let launchError; child.on("error", e => { launchError = e; }); child.unref(); fs.closeSync(log);
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      await new Promise(r => setTimeout(r, 100));
      const found = descriptor();
      if (found && await request(found, "health", {}, { timeout: 500 }).catch(() => null)) {
        if (found.configId !== configId()) throw new Error("Worker service provider settings differ; stop it before changing settings");
        return found;
      }
    }
    throw new Error(`Worker service did not start. Inspect ${path.join(location(), "service.log")}`);
  })();
  try { return await connecting; } finally { connecting = null; }
}
async function call(method, args = {}, options = {}) {
  if (method === "submit" && !args.request_id) args = { ...args, request_id: crypto.randomUUID() };
  const endpoint = method === "stop" ? descriptor() : await ensure();
  if (!endpoint) return { stopped: true };
  return request(endpoint, method, args, options);
}
module.exports = { dataDir, location, configId, request, descriptor, ensure, call };
