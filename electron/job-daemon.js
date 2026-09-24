#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { location, configId } = require("./job-client");
const { JobService } = require("./job-service");
const { executeTask } = require("./execution");
const { executeToolResult } = require("./tools");
const { ensureShellPath } = require("./shell-path");
ensureShellPath();
const root = location(), lock = path.join(root, "service.lock");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
function acquire() {
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch {}
    let alive = false;
    if (owner?.pid) { try { process.kill(owner.pid, 0); alive = true; } catch (e) { if (e.code === "EPERM") alive = true; } }
    if (alive || (!owner && Date.now() - fs.statSync(lock).mtimeMs < 15000)) return false;
    // Serialize stale-lock recovery; a second launcher must not delete a
    // replacement lock acquired by the first launcher.
    let recovery;
    try { recovery = fs.openSync(lock + ".recovery", "wx", 0o600); } catch { return false; }
    try {
      let current;
      try { current = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch {}
      if (current?.pid && current.pid !== owner?.pid) return false;
      fs.rmSync(lock, { recursive: true, force: true });
      try { fs.mkdirSync(lock); } catch { return false; }
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      return true;
    } finally { fs.closeSync(recovery); fs.rmSync(lock + ".recovery", { force: true }); }
  }
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); return true;
}
if (!acquire()) process.exit(0);
const headless = require("./headless");
const modelCatalog = require("./model-catalog");
const log = (...a) => console.error(new Date().toISOString(), ...a);
let gateway = null;
const bounded = (key, fallback, max) => { const n = Number(process.env[key]); return Number.isInteger(n) && n > 0 && n <= max ? n : fallback; };
let providerLimits = {};
try {
  const config = JSON.parse(process.env.OMNIWORK_JOB_PROVIDER_LIMITS || "{}");
  for (const [key, value] of Object.entries(config)) {
    if (Number.isInteger(value.concurrency) && value.concurrency > 0 && value.concurrency <= 32 && Number.isInteger(value.rpm) && value.rpm > 0 && value.rpm <= 60000) providerLimits[key] = value;
  }
} catch (e) { log("Ignoring invalid provider limits:", e.message); }
const service = new JobService({
  dir: path.join(root, "tasks"),
  concurrency: bounded("OMNIWORK_JOB_CONCURRENCY", 4, 32),
  providerConcurrency: bounded("OMNIWORK_JOB_PROVIDER_CONCURRENCY", 2, 32),
  requestsPerMinute: bounded("OMNIWORK_JOB_RPM", 20, 60000), providerLimits,
  catalog: async () => {
    const result = await modelCatalog.catalog(gateway);
    if (!result.models.length && result.errors.length) throw new Error(result.errors.map(e => e.message).join("; "));
    return result.models;
  },
  runCheck: (command, cwd, signal) => executeToolResult("run_command", { command }, { workspace: cwd, signal }),
  run: async opts => executeTask({ task: opts.task, signal: opts.signal, timeoutMs: opts.timeoutMs,
    checks: opts.checks, repairAttempts: opts.repair_attempts, maxTokens: opts.max_tokens, progress: opts.progress,
    createAgent: async emit => {
      const isEngine = headless.opencode.isEngineModel(opts.model);
      const gw = isEngine ? null : await headless.ensureGateway(log);
      const resolved = isEngine ? {} : await headless.resolveModelsLive(gw, { model: opts.model, fallbackModels: [] });
      const agent = headless.makeAgent({ ...resolved, baseUrl: gw?.baseUrl, apiKey: gw?.apiKey, model: opts.model, fallbackModels: [],
        workspace: opts.cwd, ...headless.agentEnv(opts.sourceCwd), emit, streaming: false, canSpawn: false,
        engineProfile: opts.engine_profile, utilityModel: opts.model, tiers: false, maxSteps: opts.max_steps, maxOutputTokens: 4096,
        allowedTools: ["list_dir", "read_file", "write_file", "edit_file", "run_command", "read_output", "use_skill", "read_knowledge"],
        beforeRequest: opts.beforeRequest, onRateLimit: opts.onRateLimit,
      });
      if (isEngine) {
        const send = agent.send.bind(agent);
        agent.send = async (...args) => { await opts.beforeRequest(opts.signal); return send(...args); };
      }
      return agent;
    },
    runCheck: (command, signal) => executeToolResult("run_command", { command }, { workspace: opts.cwd, signal }),
  }),
});
service.on("serviceError", e => log("Job persistence/execution error:", e.stack));
headless.ensureGateway(log).then(gw => { gateway = gw; service.catalogAt = 0; service.tick(); }).catch(e => log("Gateway unavailable; engine jobs may still run:", e.message));
const token = crypto.randomBytes(32).toString("hex");
let shutdownStarted = false, lastActivity = Date.now();
const server = http.createServer(async (req, res) => {
  const answer = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) return answer(401, { error: "Unauthorized" });
  if (req.method !== "POST" || req.url !== "/rpc") return answer(404, { error: "Not found" });
  lastActivity = Date.now();
  try {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 5000000) return answer(413, { error: "Request too large" }); }
    const { method, args = {} } = JSON.parse(raw);
    let value;
    switch (method) {
      case "health": value = { pid: process.pid, version: 1 }; break;
      case "submit": value = service.submit(args); break;
      case "get": value = service.get(args.id, Boolean(args.detail)); break;
      case "list": value = service.list(args); break;
      case "wait": value = await service.wait(args); break;
      case "cancel": value = service.cancel(args.id); break;
      case "read": value = await service.read(args); break;
      case "apply": value = await service.apply(args.id); break;
      case "stats": value = service.stats(); break;
      case "refresh": service.catalogAt = 0; setImmediate(() => service.tick()); value = { refreshing: true }; break;
      case "stop": value = { stopped: true }; setTimeout(shutdown, 50); break;
      default: throw new Error("Unknown worker service method");
    }
    answer(200, value);
  } catch (e) { answer(400, { error: e.message }); }
});
server.requestTimeout = 35000;
server.listen(0, "127.0.0.1", () => {
  const info = { version: 1, pid: process.pid, port: server.address().port, token, configId: configId(), startedAt: new Date().toISOString() };
  const file = path.join(root, "service.json"); fs.writeFileSync(file + ".tmp", JSON.stringify(info), { mode: 0o600 }); fs.renameSync(file + ".tmp", file);
  log("Worker service ready", process.pid);
});
const idle = setInterval(() => { if (!service.active.size && ![...service.jobs.values()].some(j => j.status === "queued") && Date.now() - lastActivity > 15 * 60000) shutdown(); }, 60000); idle.unref();
async function shutdown() {
  if (shutdownStarted) return; shutdownStarted = true;
  await service.stop(); headless.opencode.getEngine().stop();
  server.close(); server.closeAllConnections();
  fs.rmSync(path.join(root, "service.json"), { force: true }); fs.rmSync(lock, { recursive: true, force: true }); process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
