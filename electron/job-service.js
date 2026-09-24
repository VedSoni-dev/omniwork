"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const workspace = require("./job-workspace");
const TERMINAL = new Set(["completed", "failed", "partial", "cancelled", "interrupted"]);
const integer = (v, fallback, min, max) => {
  if (v == null) return fallback;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Expected integer between ${min} and ${max}`);
  return v;
};
const strings = (v, limit, width = 8000) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > limit || v.some(s => typeof s !== "string" || !s.trim() || s.length > width)) throw new Error(`Expected up to ${limit} nonempty strings, at most ${width} characters each`);
  return v.slice();
};
function normalize(input) {
  if (!input || typeof input.task !== "string" || !input.task.trim() || input.task.length > 40000) throw new Error("task must contain 1–40000 characters");
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || !fs.statSync(input.cwd).isDirectory()) throw new Error("cwd must be an existing absolute directory");
  const policy = input.policy || "free_only";
  if (!["free_only", "allow_paid"].includes(policy)) throw new Error("policy must be free_only or allow_paid");
  const model = input.model || null;
  if (model != null && (typeof model !== "string" || !model.trim() || model.length > 300)) throw new Error("model must be a model ID");
  if (model && /^auto(?:\/|$)/.test(model)) throw new Error("Omit model for managed selection, or pin a concrete model; opaque auto routes cannot enforce the job policy");
  if (policy === "allow_paid" && !model) throw new Error("allow_paid requires an explicit model");
  const engine_profile = input.engine_profile || "standard";
  if (!["focused", "scoped", "standard"].includes(engine_profile)) throw new Error("engine_profile must be focused, scoped or standard");
  const isolation = input.isolation || "worktree";
  if (!["worktree", "shared"].includes(isolation)) throw new Error("isolation must be worktree or shared");
  const verification_reserve_tokens = integer(input.verification_reserve_tokens, 0, 0, 1000000);
  const verification_reserve_ms = integer(input.verification_reserve_ms, 0, 0, 900000);
  if (verification_reserve_tokens || verification_reserve_ms) {
    if (!model?.startsWith("opencode/") || engine_profile === "standard" || isolation !== "worktree" || !input.checks?.length) throw new Error("Verification reserves require a pinned OpenCode model, scoped/focused profile, worktree isolation and acceptance checks");
    if (verification_reserve_tokens >= (input.max_tokens ?? 200000) || verification_reserve_ms >= (input.timeout_ms ?? 180000)) throw new Error("Verification reserves must be smaller than the original job budgets");
  }
  return { task: input.task, cwd: fs.realpathSync(input.cwd), model, policy, isolation, engine_profile,
    ...(verification_reserve_tokens || verification_reserve_ms ? { verification_reserve_tokens, verification_reserve_ms } : {}),
    checks: strings(input.checks, 10), setup: strings(input.setup, 4),
    allowed_paths: strings(input.allowed_paths, 100, 1000).map(workspace.relativeFile),
    context_files: strings(input.context_files, 20, 1000).map(workspace.relativeFile),
    timeout_ms: integer(input.timeout_ms, 180000, 1000, 1800000),
    max_tokens: integer(input.max_tokens, 200000, 1000, 2000000),
    max_steps: integer(input.max_steps, 24, 1, 80),
    repair_attempts: integer(input.repair_attempts, 1, 0, 3),
  };
}
function atomic(file, data) {
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function providerKey(model) {
  // Zen and Go may share capacity. Do not multiply slots by model aliases.
  return model.source === "OpenCode" && /^opencode/.test(model.provider || model.providerID) ? "opencode" : model.provider || model.providerID || model.id.split("/")[0];
}
class JobService extends EventEmitter {
  constructor({ dir, catalog, run, runCheck, concurrency = 4, providerConcurrency = 2, requestsPerMinute = 20, providerLimits = {} }) {
    super(); this.setMaxListeners(0);
    this.dir = dir; this.catalog = catalog; this.run = run; this.runCheck = runCheck;
    this.concurrency = concurrency; this.providerConcurrency = providerConcurrency; this.requestsPerMinute = requestsPerMinute; this.providerLimits = providerLimits;
    this.jobs = new Map(); this.keys = new Map(); this.active = new Map(); this.providers = new Map();
    this.models = []; this.catalogAt = 0; this.catalogError = null; this.revision = 0; this.stopping = false; this.integration = Promise.resolve();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const id of fs.readdirSync(dir)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const file = path.join(dir, id, "job.json");
      if (!fs.existsSync(file)) continue;
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      this.revision = Math.max(this.revision, job.revision || 0);
      this.jobs.set(job.id, job); if (job.key) this.keys.set(job.key, job.id);
      if (["running", "preparing", "collecting", "cancelling"].includes(job.status)) {
        job.status = "interrupted"; job.reason = "Worker service restarted. Inspect the isolated workspace before resubmitting; execution was not replayed."; this.save(job);
      }
      if (job.integration?.status === "checking") { job.integration = { status: "interrupted", reason: "Integration was interrupted; inspect the source and retained integration worktree before retrying" }; this.save(job); }
    }
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref();
    setImmediate(() => this.tick());
  }
  save(job) {
    job.revision = ++this.revision; job.updatedAt = new Date().toISOString();
    atomic(path.join(this.dir, job.id, "job.json"), job);
    this.emit("change", job.id);
  }
  submit({ tasks, request_id }) {
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > 100) throw new Error("Submit 1–100 task objects");
    if (request_id != null && (typeof request_id !== "string" || request_id.length > 200 || !request_id)) throw new Error("request_id must be a nonempty string up to 200 characters");
    const specs = tasks.map(normalize); // Validate the entire batch first.
    const batch = request_id || crypto.randomUUID();
    const entries = specs.map((spec, i) => {
      const key = `${batch}:${i}`, fingerprint = crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex");
      const existing = this.jobs.get(this.keys.get(key));
      if (existing && existing.fingerprint !== fingerprint) throw new Error("request_id was already used with different tasks");
      return { spec, key, fingerprint, existing };
    });
    const prior = [...this.jobs.values()].find(j => j.batch === batch);
    if (prior && prior.batchSize !== specs.length) throw new Error("request_id was already used with a different batch size");
    const jobs = entries.map(({ spec, key, fingerprint, existing }) => {
      if (existing) return this.view(existing);
      const id = crypto.randomUUID();
      fs.mkdirSync(path.join(this.dir, id), { mode: 0o700 });
      const job = { id, key, fingerprint, batch, batchSize: specs.length, spec, status: "queued", createdAt: new Date().toISOString(), result: null, progress: null };
      // Admission must reach disk before the scheduler can see this job.
      this.save(job); this.jobs.set(id, job); this.keys.set(key, id); return this.view(job);
    });
    setImmediate(() => this.tick());
    return { request_id: batch, revision: this.revision, jobs };
  }
  job(id) { const j = this.jobs.get(id); if (!j) throw new Error("Unknown job ID"); return j; }
  view(job, detail = false) {
    if (detail) return JSON.parse(JSON.stringify(job));
    return { id: job.id, status: job.status, revision: job.revision, model: job.model?.id || job.spec.model,
      createdAt: job.createdAt, updatedAt: job.updatedAt, reason: job.reason || job.result?.reason || null,
      progress: job.progress, verification: job.result?.verification?.status || "unverified",
      summary: job.result?.summary?.slice(0, 1600) || "", usage: job.result?.usage || null,
      trace: job.trace?.summary || null,
      timings: job.timings || null,
      files: job.artifact?.files || [], outsideScope: job.artifact?.outsideScope || [],
      workspace: job.workspace?.cwd || null, patch: job.artifact?.patch || null, appliedAt: job.appliedAt || null, integration: job.integration?.status || null };
  }
  get(id, detail) { return this.view(this.job(id), detail); }
  list({ limit = 20, offset = 0, status } = {}) {
    const all = [...this.jobs.values()].reverse().filter(j => !status || j.status === status);
    const start = integer(offset, 0, 0, 1000000);
    return { total: all.length, jobs: all.slice(start, start + integer(limit, 20, 1, 100)).map(j => this.view(j)) };
  }
  state(key) {
    if (!this.providers.has(key)) this.providers.set(key, { active: 0, nextRequestAt: 0, cooldownUntil: 0, requests: 0, completed: 0, failed: 0, latencyMs: null });
    return this.providers.get(key);
  }
  async beforeRequest(key, signal) {
    const state = this.state(key);
    const rpm = this.providerLimits[key]?.rpm || this.requestsPerMinute;
    for (;;) {
      signal?.throwIfAborted();
      const now = Date.now(), delay = Math.max(state.nextRequestAt, state.cooldownUntil) - now;
      if (delay <= 0) { state.nextRequestAt = now + 60000 / rpm; state.requests++; return; }
      await new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(delay, 1000));
        const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason || new Error("Cancelled")); };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  rateLimited(key, ms = 60000) { this.state(key).cooldownUntil = Math.max(this.state(key).cooldownUntil, Date.now() + Math.min(Math.max(ms, 1000), 300000)); }
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const waiting = [...this.jobs.values()].filter(j => ["queued", "blocked"].includes(j.status));
      if (!waiting.length) return;
      if (Date.now() - this.catalogAt > 30000) {
        try { this.models = await this.catalog(); this.catalogError = null; } catch (e) { this.catalogError = e.message; }
        this.catalogAt = Date.now();
      }
      for (const job of waiting) {
        if (this.stopping) break;
        if (!["queued", "blocked"].includes(job.status)) continue;
        if (job.deadlineAt && Date.now() >= job.deadlineAt) { job.status = "partial"; job.reason = "Job deadline exceeded while waiting for provider recovery"; this.save(job); continue; }
        if (this.active.size >= this.concurrency) continue;
        let candidates = this.models.filter(m => (!job.spec.model || job.spec.model === m.id) && m.tools !== false && !/^auto(?:\/|$)/.test(m.id));
        if (job.spec.policy === "free_only") candidates = candidates.filter(m => m.free === true);
        if (!candidates.length) {
          const reason = this.catalogError || "No connected model meets the job policy. Connect a provider or submit an explicitly allowed model.";
          if (job.status !== "blocked" || job.reason !== reason) { job.status = "blocked"; job.reason = reason; this.save(job); }
          continue;
        }
        candidates = candidates.filter(m => { const k = providerKey(m), s = this.state(k); return s.active < (this.providerLimits[k]?.concurrency || this.providerConcurrency) && s.cooldownUntil <= Date.now(); });
        candidates.sort((a,b) => {
          const x = this.state(providerKey(a)), y = this.state(providerKey(b));
          return x.active - y.active || x.failed / (x.completed + 1) - y.failed / (y.completed + 1) || (x.latencyMs || 10000) - (y.latencyMs || 10000);
        });
        if (candidates.length) this.start(job, candidates[0]);
      }
    } catch (e) { this.emit("serviceError", e); }
    finally { this.ticking = false; }
  }
  start(job, model) {
    const ctl = new AbortController(), key = providerKey(model), state = this.state(key);
    job.model = model; job.provider = key; job.status = "preparing"; job.reason = null; job.startedAt ||= new Date().toISOString();
    job.deadlineAt ||= Date.now() + job.spec.timeout_ms;
    this.save(job); this.active.set(job.id, ctl); state.active++;
    const dir = path.join(this.dir, job.id), started = Date.now();
    job.timings = { queueMs: (job.timings?.queueMs || 0) + Math.max(0, started - Date.parse(job.queuedAt || job.createdAt)) };
    const deadline = setTimeout(() => ctl.abort(new Error("Job deadline exceeded")), Math.max(1, job.deadlineAt - Date.now()));
    let lastProgress = 0;
    (async () => {
      try {
        job.workspace ||= await workspace.prepare(job.spec, dir); ctl.signal.throwIfAborted(); this.save(job);
        for (const command of job.setupComplete ? [] : job.spec.setup) {
          const r = await this.runCheck(command, job.workspace.cwd, ctl.signal);
          if (!r.ok) throw new Error(`Setup failed: ${r.text.slice(-4000)}`);
        }
        job.setupComplete = true; this.save(job);
        const prompt = await workspace.context(job.spec, job.workspace);
        ctl.signal.throwIfAborted(); job.status = "running"; this.save(job);
        job.timings.preparationMs = Date.now() - started;
        const priorTokens = (job.providerHistory || []).reduce((n, attempt) => n + (attempt.usage?.inTokens || 0) + (attempt.usage?.outTokens || 0), 0);
        job.result = await this.run({ ...job.spec, task: prompt, cwd: job.workspace.cwd, sourceCwd: job.spec.cwd, model: model.id, signal: ctl.signal,
          max_tokens: Math.max(1, job.spec.max_tokens - priorTokens),
          timeoutMs: Math.max(1, job.deadlineAt - Date.now()),
          beforeRequest: signal => this.beforeRequest(key, signal), onRateLimit: ms => this.rateLimited(key, ms),
          progress: (step, message) => { job.progress = { step, message: String(message).slice(0, 300) }; if (Date.now() - lastProgress > 500) { lastProgress = Date.now(); this.save(job); } },
        });
        job.status = this.stopping ? "interrupted" : ctl.signal.aborted ? (ctl.signal.reason?.message === "Job deadline exceeded" ? "partial" : "cancelled") : job.result.status;
        job.reason = this.stopping ? "Worker service stopped" : ctl.signal.aborted ? ctl.signal.reason?.message || "Cancelled" : job.result.reason;
      } catch (e) {
        job.status = this.stopping ? "interrupted" : ctl.signal.aborted ? (ctl.signal.reason?.message === "Job deadline exceeded" ? "partial" : "cancelled") : "failed";
        job.reason = e.message;
      } finally {
        clearTimeout(deadline);
        job.timings.executionMs = job.result?.elapsedMs ?? null;
        const collectionStarted = Date.now();
        let outcome = job.status;
        job.status = "collecting"; this.save(job);
        if (job.workspace) {
          try { job.artifact = await workspace.collect(job.workspace, dir, job.spec.allowed_paths); }
          catch (e) { job.reason = `Could not collect patch: ${e.message}`; if (outcome === "completed") outcome = "partial"; }
        }
        if (job.artifact?.outsideScope?.length) { outcome = "partial"; job.reason = "Worker edited files outside allowed_paths; patch requires review"; }
        if (job.result?.trace) {
          atomic(path.join(dir, "trace.json"), job.result.trace);
          job.trace = { summary: job.result.trace.summary };
          delete job.result.trace;
        }
        if (job.result) atomic(path.join(dir, "result.json"), job.result);
        job.status = this.stopping ? "interrupted" : ctl.signal.aborted && ctl.signal.reason?.message !== "Job deadline exceeded" ? "cancelled" : outcome;
        // Retry only native provider failures before ANY tool ran. Never replay
        // side effects or opaque engine execution. Keep the original deadline.
        const retryable = !model.id.startsWith("opencode/") && job.result?.toolCalls === 0 && /Gateway (429|503)|Lost connection to the engine/i.test(job.reason || "");
        const spentTokens = [...(job.providerHistory || []), job.result || {}].reduce((n, attempt) => n + (attempt.usage?.inTokens || 0) + (attempt.usage?.outTokens || 0), 0);
        if (job.status === "failed" && retryable && spentTokens >= job.spec.max_tokens) {
          job.status = "partial"; job.reason = "Observed token budget exhausted before provider retry";
        }
        if (!this.stopping && !ctl.signal.aborted && job.status === "failed" && retryable && (job.providerRetries || 0) < 2) {
          job.providerRetries = (job.providerRetries || 0) + 1;
          job.providerHistory ||= []; job.providerHistory.push({ model: model.id, reason: job.reason, usage: job.result.usage });
          this.rateLimited(key, /429/.test(job.reason) ? 60000 : 5000);
          job.status = "queued"; job.reason = "Waiting for provider recovery before a safe retry";
          job.queuedAt = new Date().toISOString();
        }
        if (TERMINAL.has(job.status)) job.finishedAt = new Date().toISOString();
        job.timings.collectionMs = Date.now() - collectionStarted;
        this.save(job);
        state.active--; state[job.status === "completed" ? "completed" : "failed"]++;
        state.latencyMs = state.latencyMs == null ? Date.now() - started : state.latencyMs * 0.8 + (Date.now() - started) * 0.2;
        if (/429|rate.limit/i.test(job.result?.reason || job.reason || "")) this.rateLimited(key);
        this.active.delete(job.id); setImmediate(() => this.tick());
      }
    })().catch(e => {
      // A persistence failure cannot leave a live worker or a leaked capacity slot.
      ctl.abort(e); clearTimeout(deadline);
      if (this.active.delete(job.id)) state.active--;
      this.emit("serviceError", e);
    });
  }
  cancel(id) {
    const job = this.job(id);
    if (TERMINAL.has(job.status)) return this.view(job);
    const active = this.active.get(id);
    job.status = active ? "cancelling" : "cancelled"; job.reason = "Cancelled by caller"; this.save(job);
    active?.abort(new Error("Cancelled by caller")); return this.view(job);
  }
  async wait({ ids, after_revision, timeout_ms = 25000 }) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new Error("wait requires 1–100 job IDs");
    ids.forEach(id => this.job(id));
    const snapshot = () => ({ revision: Math.max(...ids.map(id => this.job(id).revision)), jobs: ids.map(id => this.get(id)) });
    const changed = () => after_revision == null ? ids.some(id => TERMINAL.has(this.job(id).status)) : ids.some(id => this.job(id).revision > after_revision);
    if (changed() || timeout_ms === 0) return snapshot();
    await new Promise(resolve => {
      const cleanup = () => { clearTimeout(timer); this.removeListener("change", onChange); resolve(); };
      const onChange = id => { if (ids.includes(id) && changed()) cleanup(); };
      const timer = setTimeout(cleanup, integer(timeout_ms, 25000, 0, 25000));
      this.on("change", onChange);
      if (changed()) cleanup();
    });
    return snapshot();
  }
  async read({ id, artifact = "patch", offset = 0, limit = 12000 }) {
    const job = this.job(id);
    if (!["patch", "result", "trace"].includes(artifact)) throw new Error("artifact must be patch, result or trace");
    const file = artifact === "patch" ? job.artifact?.patch : artifact === "trace" ? job.trace && path.join(this.dir, id, "trace.json") : job.result && path.join(this.dir, id, "result.json");
    if (!file) throw new Error("Artifact is not available yet");
    const text = await fs.promises.readFile(file, "utf8");
    const start = integer(offset, 0, 0, text.length), count = integer(limit, 12000, 1, 24000);
    return { id, artifact, text: text.slice(start, start + count), total: text.length, next_offset: start + count < text.length ? start + count : null };
  }
  async apply(id) {
    const run = async () => {
      const job = this.job(id);
      if (job.appliedAt) return { appliedAt: job.appliedAt, alreadyApplied: true };
      job.integration = { status: "checking" }; this.save(job);
      try {
        const result = await workspace.apply(job, path.join(this.dir, id), (cmd,cwd) => this.runCheck(cmd, cwd, AbortSignal.timeout(60000)));
        job.integration = { ...result, status: result.appliedAt ? "applied" : "failed" }; if (result.appliedAt) job.appliedAt = result.appliedAt; this.save(job); return result;
      } catch (e) { job.integration = { status: "failed", reason: e.message }; this.save(job); throw e; }
    };
    const pending = this.integration.then(run); this.integration = pending.catch(() => {}); return pending;
  }
  stats() {
    const counts = {}; for (const j of this.jobs.values()) counts[j.status] = (counts[j.status] || 0) + 1;
    return { counts, active: this.active.size, concurrency: this.concurrency, providers: Object.fromEntries(this.providers), catalogError: this.catalogError };
  }
  async stop() {
    this.stopping = true; clearInterval(this.timer);
    for (const ctl of this.active.values()) ctl.abort(new Error("Worker service stopped"));
    const end = Date.now() + 5000;
    while (this.active.size && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  }
}
module.exports = { JobService, normalize, TERMINAL, providerKey };
