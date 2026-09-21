"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { JobService, TERMINAL, normalize } = require("../electron/job-service");
const { git } = require("../electron/job-workspace");
const { executeTask } = require("../electron/execution");
const { executeToolResult } = require("../electron/tools");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-jobs-"));
const repo = path.join(root, "repo"), store = path.join(root, "store");
let service, passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("✓", name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function terminal(id, maxMs = 20000) {
  const until = Date.now() + maxMs;
  while (!TERMINAL.has(service.job(id).status)) { if (Date.now() > until) throw new Error(`Job timed out: ${JSON.stringify(service.get(id))}`); await sleep(20); }
  return service.get(id, true);
}
const fileCheck = (file, value) => `node -e 'if(require("fs").readFileSync(${JSON.stringify(file)},"utf8")!==${JSON.stringify(value)})process.exit(1)'`;
const runCheck = (command, cwd, signal) => executeToolResult("run_command", { command }, { workspace: cwd, signal });
const model = { id: "local/coder", provider: "local", free: true, tools: true };
(async () => {
  fs.mkdirSync(repo); await git(repo, ["init", "-q"]); await git(repo, ["config", "user.email", "test@localhost"]); await git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n"); fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  await git(repo, ["add", "."]); await git(repo, ["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "user edit\n"); fs.writeFileSync(path.join(repo, "note.txt"), "untracked context"); fs.writeFileSync(path.join(repo, "ignored.txt"), "private fixture");
  const initialIndex = await git(repo, ["diff", "--cached", "--binary"]);
  let active = 0, peak = 0, runs = 0;
  const run = async opts => {
    active++; peak = Math.max(peak, active); runs++;
    try {
      assert.equal(fs.readFileSync(path.join(opts.cwd, "base.txt"), "utf8"), "user edit\n");
      assert.equal(fs.readFileSync(path.join(opts.cwd, "note.txt"), "utf8"), "untracked context");
      assert(!fs.existsSync(path.join(opts.cwd, "ignored.txt")));
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, opts.task.startsWith("SLOW") ? 2000 : 60); opts.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Cancelled")); }, { once: true }); });
      const name = opts.task.split("\n")[0]; fs.writeFileSync(path.join(opts.cwd, name), "good");
      opts.progress(1, "wrote fixture");
      const checks = [];
      for (const command of opts.checks) { const r = await runCheck(command, opts.cwd, opts.signal); checks.push({ command, ok: r.ok, exitCode: r.exitCode, output: r.text }); }
      return { status: checks.every(c => c.ok) ? "completed" : "failed", reason: null, summary: "done", changes: [], attempts: [], verification: { status: checks.length ? checks.every(c => c.ok) ? "passed" : "failed" : "unverified", checks }, usage: { inTokens: 10, outTokens: 2, available: true }, toolCalls: 1 };
    } finally { active--; }
  };
  const options = { dir: store, catalog: async () => [model, { id: "paid/coder", provider: "paid", free: false, tools: true }], run, runCheck, concurrency: 3, providerConcurrency: 2, requestsPerMinute: 60000 };
  service = new JobService(options);
  const spec = i => ({ cwd: repo, task: `file${i}.txt`, model: model.id, allowed_paths: [`file${i}.txt`], checks: [fileCheck(`file${i}.txt`, "good")] });
  check("worker profile defaults are explicit and invalid profiles are rejected", () => {
    assert.equal(normalize(spec(1)).engine_profile, "standard");
    for (const engine_profile of ["standard", "scoped", "focused"]) {
      assert.equal(normalize({ ...spec(1), engine_profile }).engine_profile, engine_profile);
    }
    assert.throws(() => normalize({ ...spec(1), engine_profile: "unknown" }), /engine_profile/);
  });
  const save = service.save;
  service.save = () => { throw new Error("fixture disk full"); };
  check("failed persistence cannot admit an executable job", () => {
    assert.throws(() => service.submit({ tasks: [spec(99)] }), /disk full/);
    assert.equal(service.jobs.size, 0); assert.equal(service.keys.size, 0);
  });
  service.save = save;
  const batch = service.submit({ request_id: "batch-one", tasks: [spec(1), spec(2), spec(3)] });
  const second = service.submit({ request_id: "batch-two", tasks: [spec(4), spec(5), spec(6)] });
  check("submission is durable before returning and idempotent", () => {
    assert(fs.existsSync(path.join(store, batch.jobs[0].id, "job.json")));
    assert.deepEqual(service.submit({ request_id: "batch-one", tasks: [spec(1), spec(2), spec(3)] }).jobs.map(j => j.id), batch.jobs.map(j => j.id));
    assert.throws(() => service.submit({ request_id: "batch-one", tasks: [spec(9)] }));
  });
  const jobs = await Promise.all([...batch.jobs, ...second.jobs].map(j => terminal(j.id)));
  check("global provider slots apply across batches and all jobs finish", () => { assert.equal(peak, 2); assert(jobs.every(j => j.status === "completed")); assert.equal(runs, 6); });
  check("worktrees preserve dirty context without editing source or its index", () => {
    assert(!fs.existsSync(path.join(repo, "file1.txt"))); assert(jobs.every(j => j.workspace.isolated)); assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "user edit\n");
  });
  assert.equal(await git(repo, ["diff", "--cached", "--binary"]), initialIndex);
  const artifact = await service.read({ id: jobs[0].id, limit: 60 });
  check("patch artifacts are paged and include new files", () => { assert(artifact.next_offset); assert(jobs[0].artifact.files.includes("file1.txt")); });
  const applied = await service.apply(jobs[0].id);
  check("verified application reruns checks and writes the intended file", () => { assert(applied.applied); assert.equal(fs.readFileSync(path.join(repo, "file1.txt"), "utf8"), "good"); });
  assert.equal(await git(repo, ["diff", "--cached", "--binary"]), initialIndex);
  check("applying again is idempotent", () => assert(service.job(jobs[0].id).appliedAt));
  assert((await service.apply(jobs[0].id)).alreadyApplied);
  fs.writeFileSync(path.join(repo, "file2.txt"), "user's concurrent change");
  await assert.rejects(service.apply(jobs[1].id), /Source changed/);
  check("overlapping source changes are rejected without overwrite", () => assert.equal(fs.readFileSync(path.join(repo, "file2.txt"), "utf8"), "user's concurrent change"));
  const scoped = service.submit({ tasks: [{ ...spec(7), allowed_paths: ["another.txt"] }] }).jobs[0];
  const scopeResult = await terminal(scoped.id);
  check("out-of-scope edits cannot pass as completed", () => { assert.equal(scopeResult.status, "partial"); assert(scopeResult.artifact.outsideScope.includes("file7.txt")); });
  await assert.rejects(service.apply(scoped.id), /within their allowed paths/);
  const mutation = service.submit({ tasks: [{ ...spec(10), checks: [fileCheck("file10.txt", "good"), "node -e 'if(process.cwd().endsWith(\"integration\"))require(\"fs\").writeFileSync(\"file10.txt\",\"changed by check\")'"] }] }).jobs[0];
  await terminal(mutation.id);
  await assert.rejects(service.apply(mutation.id), /changed a patch file/);
  check("integration refuses a patch altered by acceptance commands", () => assert(!fs.existsSync(path.join(repo,"file10.txt"))));
  const blocked = service.submit({ tasks: [{ ...spec(8), model: "paid/coder" }] }).jobs[0];
  await service.tick();
  check("free-only policy blocks paid models instead of silently spending", () => assert.equal(service.job(blocked.id).status, "blocked"));
  service.cancel(blocked.id);
  check("queued cancellation is terminal", () => assert.equal(service.job(blocked.id).status, "cancelled"));
  const slow = service.submit({ tasks: [{ ...spec(9), task: "SLOW.txt" }] }).jobs[0];
  while (service.job(slow.id).status !== "running") await sleep(20);
  service.cancel(slow.id); const cancelled = await terminal(slow.id);
  check("active cancellation stops the worker and retains its workspace", () => { assert.equal(cancelled.status, "cancelled"); assert(fs.existsSync(cancelled.workspace.cwd)); });
  let retries = 0; const originalRun = service.run;
  service.run = async opts => {
    if (++retries === 1) return { status:"failed", reason:"Gateway 503: fixture unavailable", toolCalls:0, usage:{available:true,inTokens:1000,outTokens:20}, verification:{status:"unverified",checks:[]} };
    assert.equal(opts.max_tokens, 198980);
    return originalRun(opts);
  };
  const retry = service.submit({ tasks:[spec(11)] }).jobs[0];
  while(!service.job(retry.id).providerRetries) await sleep(20);
  const retryWorkspace = service.job(retry.id).workspace.cwd;
  service.state("local").cooldownUntil = 0;
  const recovered = await terminal(retry.id);
  service.run = originalRun;
  check("pre-tool provider recovery preserves workspace and original deadline",()=>{assert.equal(retries,2);assert.equal(recovered.workspace.cwd,retryWorkspace);assert.equal(recovered.status,"completed");assert.equal(recovered.providerHistory.length,1);});

  // Verification repairs use the SAME agent and aggregate both turns' usage.
  let sends = 0;
  const repaired = await executeTask({ task: "implement", checks: ["fixture"], repairAttempts: 1,
    createAgent: async emit => ({ model: "fixture", lastText: "", abort() {}, async send(prompt) { sends++; if (sends === 2) assert(prompt.includes("expected good")); emit("stats", { inTokens: 10, outTokens: 2, uncachedInTokens: 3, cacheReadTokens: 7, modelRequests: 1 }); emit("done", { inTokens: 10, outTokens: 2, uncachedInTokens: 3, cacheReadTokens: 7, modelRequests: 1 }); } }),
    runCheck: async () => ({ ok: sends > 1, exitCode: sends > 1 ? 0 : 1, text: "expected good" }),
  });
  check("failed checks trigger bounded repair with cumulative usage", () => { assert.equal(sends, 2); assert.equal(repaired.verification.status, "passed"); assert.equal(repaired.status, "completed"); assert.equal(repaired.usage.inTokens, 20); assert.equal(repaired.usage.uncachedInTokens, 6); assert.equal(repaired.usage.cacheReadTokens, 14); assert.equal(repaired.usage.modelRequests, 2); assert.equal(repaired.checkHistory.length, 1); });
  const exhausted = await executeTask({ task: "work", maxTokens: 5, createAgent: async emit => ({ model: "fixture", abort() {}, async send() { emit("stats", { inTokens: 10, outTokens: 0 }); } }) });
  check("observed token budgets stop further work visibly", () => { assert.equal(exhausted.status, "partial"); assert.match(exhausted.reason, /token budget/); });
  service.rateLimited("local", 1000); const time = Date.now(); await service.beforeRequest("local");
  check("provider cooldown gates subsequent requests", () => assert(Date.now() - time >= 950));

  await service.stop();
  const manifest = path.join(store, jobs[2].id, "job.json"); const interrupted = JSON.parse(fs.readFileSync(manifest)); interrupted.status = "running"; fs.writeFileSync(manifest, JSON.stringify(interrupted));
  const count = runs; service = new JobService(options);
  check("restart preserves results and marks uncertain execution interrupted", () => { assert.equal(service.job(jobs[2].id).status, "interrupted"); assert.equal(service.job(jobs[0].id).status, "completed"); assert.equal(runs, count); });
  const wait = await service.wait({ ids: [jobs[0].id], timeout_ms: 0 });
  check("compact wait returns durable revision and result", () => assert(wait.revision > 0 && wait.jobs[0].verification === "passed"));
  console.log(`\n✅ JOB SERVICE TEST PASSED (${passed} checks)`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await service?.stop(); fs.rmSync(root, { recursive: true, force: true }); });
