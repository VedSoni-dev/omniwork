#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const exec = promisify(execFile);
const { git } = require("../electron/job-workspace");
const { cases, program } = require("../benchmarks/coding-cases");
const { transient, readWithRetry, writeJSON, summarize } = require("../benchmarks/runner-support");
const args = process.argv.slice(2);
const value = (key, otherwise) => args.includes(key) ? args[args.indexOf(key) + 1] : otherwise;
const resume = value("--resume", null);
const live = args.includes("--live") || Boolean(resume);
const output = path.resolve(resume || value("--output", "reviews/coding-benchmark.json"));
const checkpoint = output + ".state.json";
let state = resume ? JSON.parse(fs.readFileSync(checkpoint, "utf8")) : null;
const root = state?.root || fs.mkdtempSync(path.join(os.tmpdir(), "ow-coding-bench-"));
// Only clean up directories created by this harness, even for edited checkpoints.
if (path.dirname(fs.realpathSync(root)) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("ow-coding-bench-")) throw Error("Invalid benchmark workspace");
process.env.OMNIWORK_DATA_DIR = path.join(root, "data");
process.env.OMNIWORK_JOB_RPM = "120";
// This benchmark uses only OpenCode. Avoid booting an unused gateway sidecar.
process.env.OMNIWORK_BASE_URL = "http://127.0.0.1:1/v1";
process.env.OMNIWORK_API_KEY = "benchmark-unused-gateway";
const client = require("../electron/job-client");
let report = resume ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
let startedService = false, completed = false, stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
const stopCheck = () => { if (stopping) throw Error("Benchmark interrupted by caller"); };
const read = (method, params) => readWithRetry(client.call, method, params, {
  onRetry: event => { console.log("RETRY", event.method, event.attempt, event.error); if (report) { report.transportRetries ||= []; report.transportRetries.push(event); save(); } },
});
function save() {
  if (!report) return;
  report.summary = summarize(report.rows, report.profiles);
  report.unfinished = state.plans.filter(p => !report.rows.some(r => r.id === p.id)).map(p => p.id || p.case);
  report.elapsedMs = Date.now() - report.startedAt;
  writeJSON(output, report);
  writeJSON(checkpoint, state);
}
async function runNode(file, cwd, rootArg = cwd) {
  try { await exec(process.execPath, [file, rootArg], { cwd, timeout: 25000, maxBuffer: 1024 * 1024 }); return { passed: true }; }
  catch (e) { return { passed: false, output: String(e.stderr || e.message).slice(-5000) }; }
}
function populate(repo, task, modules) {
  fs.mkdirSync(path.join(repo, "electron"), { recursive: true });
  for (const [file, text] of modules) fs.writeFileSync(path.join(repo, "electron", file), text);
  fs.writeFileSync(path.join(repo, "public.cjs"), program(task.public));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "omniwork-regression-fixture", private: true, scripts: { test: "node public.cjs ." } }));
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Preserve public APIs and unrelated files. Implement the requested behavior without weakening checks. Run node public.cjs . before finishing.\n");
}
function mutate(repo, task) {
  for (const [file, from, to] of task.mutations) {
    const p = path.join(repo, file), source = fs.readFileSync(p, "utf8");
    if (source.split(from).length !== 2) throw Error(`Mutation drift: ${task.id} ${file}`);
    fs.writeFileSync(p, source.replace(from, to));
  }
}
async function prepare() {
  const repeats = Number(value("--repeats", "2"));
  const timeout = Number(value("--timeout-ms", "180000"));
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw Error("--repeats must be 1–5");
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) throw Error("--timeout-ms must be 1000–600000");
  const profiles = value("--profiles", "standard,scoped").split(",");
  if (profiles.length !== 2 || new Set(profiles).size !== 2 || profiles.some(p => !["standard", "focused", "scoped"].includes(p))) throw Error("--profiles requires two distinct supported profiles");
  const selected = value("--cases", cases.map(c => c.id).join(",")).split(",");
  if (selected.some(id => !cases.some(c => c.id === id))) throw Error("Unknown benchmark case");
  const tasks = cases.filter(c => selected.includes(c.id));
  const model = value("--model", "opencode/big-pickle");
  const source = path.resolve(__dirname, "../electron");
  const modules = fs.readdirSync(source).filter(f => f.endsWith(".js")).sort().map(f => [f, fs.readFileSync(path.join(source, f), "utf8")]);
  const sourceHash = crypto.createHash("sha256").update(JSON.stringify(modules)).digest("hex");
  const preflight = [];
  for (const task of tasks) {
    stopCheck();
    const repo = path.join(root, "preflight", task.id), hidden = path.join(root, task.id + ".heldout.cjs");
    populate(repo, task, modules); fs.writeFileSync(hidden, program(task.hidden));
    const gold = await runNode(hidden, repo);
    const smoke = await runNode(path.join(repo, "public.cjs"), repo, ".");
    if (!gold.passed || !smoke.passed) throw Error(`Gold failed ${task.id}: ${gold.output || smoke.output}`);
    mutate(repo, task);
    for (const file of task.files) await exec(process.execPath, ["--check", file], { cwd: repo });
    if ((await runNode(hidden, repo)).passed) throw Error(`Mutation survived ${task.id}`);
    preflight.push({ id: task.id, goldPassed: true, mutantRejected: true });
    console.log("PREFLIGHT", task.id, "gold passes, regression fails");
  }
  if (!live) { console.log("Preflight passed. Add --live to run paired model comparisons."); return; }
  state = { root, request_id: "paired-coding-" + crypto.randomUUID(), plans: [] };
  for (let round = 0; round < repeats; round++) {
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      for (const profile of (round + index) % 2 ? profiles.slice().reverse() : profiles) {
        stopCheck();
        const cwd = path.join(root, `r${round}-${task.id}-${profile}`);
        populate(cwd, task, modules); mutate(cwd, task);
        await git(cwd, ["init", "-q"]);
        await git(cwd, ["config", "user.name", "OmniWork Benchmark"]);
        await git(cwd, ["config", "user.email", "benchmark@localhost"]);
        await git(cwd, ["add", "."]); await git(cwd, ["commit", "-qm", "regression fixture"]);
        state.plans.push({ case: task.id, round, profile, spec: {
          cwd, task: task.task + " Work only in the owned modules. Public smoke tests are in public.cjs; additional evaluator checks cover the stated behavior.",
          model, engine_profile: profile, allowed_paths: task.files, context_files: [...task.files, "public.cjs"],
          checks: ["node public.cjs ."], timeout_ms: timeout, max_tokens: 600000, repair_attempts: 1,
        } });
      }
    }
  }
  report = { testedAt: new Date().toISOString(), startedAt: Date.now(), complete: false,
    sourceHash, engineVersion: require("../electron/opencode-engine").version(), model, repeats, profiles,
    scope: "Controlled regressions in actual OmniWork modules, alternating profile order, withheld evaluator tests. Not SWE-bench or an unbiased sample of organic issues.",
    timeoutMs: timeout, preflight, rows: [], repositoryModules: modules.length };
  fs.mkdirSync(path.dirname(output), { recursive: true }); save();
}
async function evaluate(plan, detail) {
  const hiddenFile = path.join(root, plan.case + ".heldout.cjs");
  const hidden = detail.workspace?.cwd ? await runNode(hiddenFile, detail.workspace.cwd) : { passed: false, output: "No worker workspace" };
  let integration = null;
  if (detail.status === "completed" && hidden.passed) {
    // Application is never blindly replayed after an ambiguous transport error.
    if (detail.appliedAt) integration = { applied: true, appliedAt: detail.appliedAt, alreadyApplied: true };
    else {
      try { integration = await client.call("apply", { id: plan.id }, { timeout: 900000 }); }
      catch (e) { if (transient(e)) throw e; integration = { applied: false, reason: e.message }; }
    }
  }
  const final = integration?.appliedAt ? await runNode(hiddenFile, plan.spec.cwd) : { passed: false };
  if (detail.artifact?.patch) {
    fs.mkdirSync(output + ".patches", { recursive: true });
    fs.copyFileSync(detail.artifact.patch, path.join(output + ".patches", `${plan.case}-r${plan.round}-${plan.profile}.patch`));
  }
  if (detail.trace) {
    fs.mkdirSync(output + ".traces", { recursive: true });
    fs.copyFileSync(path.join(root, "data", "jobs", "tasks", plan.id, "trace.json"), path.join(output + ".traces", `${plan.case}-r${plan.round}-${plan.profile}.json`));
  }
  return { id: plan.id, case: plan.case, round: plan.round, profile: plan.profile, status: detail.status,
    trace: detail.trace?.summary || null, timings: detail.timings || null,
    reason: detail.reason, result: detail.result, files: detail.artifact?.files, heldout: hidden, integration, accepted: Boolean(final.passed) };
}
(async () => {
  if (!resume) await prepare();
  if (!live) { completed = true; return; }
  stopCheck(); await client.ensure(); startedService = true;
  if (state.plans.some(p => !p.id)) {
    // A stable key also recovers an interrupted/uncertain admission on --resume.
    const start = Date.now();
    const batch = await client.call("submit", { request_id: state.request_id, tasks: state.plans.map(p => p.spec) }, { timeout: 60000 });
    state.plans.forEach((p, i) => { p.id = batch.jobs[i].id; });
    report.submissionMs = Date.now() - start; save();
  }
  delete report.error;
  const end = Date.now() + state.plans.length * (report.timeoutMs + 30000);
  const terminal = new Set(["completed", "failed", "partial", "cancelled", "interrupted"]);
  while (Date.now() < end) {
    stopCheck();
    const pending = state.plans.filter(p => !report.rows.some(r => r.id === p.id));
    if (!pending.length) break;
    const result = await read("wait", { ids: pending.map(p => p.id), timeout_ms: 10000 });
    for (const job of result.jobs) {
      stopCheck(); if (!terminal.has(job.status)) continue;
      const plan = state.plans.find(p => p.id === job.id);
      const detail = await read("get", { id: job.id, detail: true });
      const row = await evaluate(plan, detail);
      report.rows.push(row); save();
      console.log(row.profile, row.case, row.status, "heldout=" + row.heldout.passed, "accepted=" + row.accepted, "input=" + row.result?.usage?.inTokens);
    }
  }
  completed = report.rows.length === state.plans.length;
  report.complete = completed; save(); console.log(JSON.stringify(report.summary, null, 2));
  if (!completed || report.rows.some(r => !r.accepted)) process.exitCode = 1;
})().catch(e => {
  console.error(e);
  if (report) { report.error = e.message; report.complete = false; save(); }
  process.exitCode = 1;
}).finally(async () => {
  if (startedService) await client.call("stop", {}, { timeout: 15000 }).catch(() => {});
  if (completed || !report) {
    await new Promise(r => setTimeout(r, 500));
    fs.rmSync(root, { recursive: true, force: true });
    if (report) fs.rmSync(checkpoint, { force: true });
  } else console.error(`Evidence retained. Resume with: node scripts/benchmark-coding.js --resume ${output}`);
});
