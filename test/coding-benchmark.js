"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os");
const path = require("node:path"), assert = require("node:assert/strict");
const { readWithRetry, summarize } = require("../benchmarks/runner-support");
(async () => {
  let calls = 0;
  const recovered = await readWithRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error("delayed response"), { name: "TimeoutError" });
    return { id: "same-job", status: "completed" };
  }, "get", { id: "same-job" }, { pause: async () => {} });
  assert.equal(calls, 3); assert.equal(recovered.id, "same-job");
  await assert.rejects(readWithRetry(async () => {}, "submit", {}), /Only read/);
  await assert.rejects(readWithRetry(async () => {}, "apply", {}), /Only read/);
  calls = 0;
  await assert.rejects(readWithRetry(async () => { calls++; throw Error("Unknown job ID"); }, "get", {}, { pause: async () => {} }), /Unknown job/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(readWithRetry(async () => { calls++; throw Error("fetch failed"); }, "wait", {}, { pause: async () => {} }), /fetch failed/);
  assert.equal(calls, 4);
  const stats = summarize([
    { profile: "a", accepted: true, result: { usage: { available: true, inTokens: 100 }, elapsedMs: 10 } },
    { profile: "a", accepted: false, result: { usage: { available: true, inTokens: 50 }, elapsedMs: 20 } },
    { profile: "a", accepted: false },
  ], ["a", "b"]);
  assert.equal(stats.a.inputPerAccepted, 150); assert.equal(stats.a.attempted, 2);
  assert.equal(stats.a.usageAvailable, 2); assert.equal(stats.b.inputPerAccepted, null);
  console.log("✓ benchmark retries reads without replaying writes; summaries include failed work and expose missing usage");
  const result = spawnSync(process.execPath, [path.join(__dirname, "../scripts/benchmark-coding.js")], { encoding: "utf8", timeout: 60000 });
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
  if (result.error) console.error(result.error);
  assert.equal(result.status, 0, result.error?.message || "Preflight failed");
  // Interrupt a real runner/daemon pair using synthetic inference, then recover
  // exactly the same admission. A fake model does not repair the seeded faults:
  // failures must survive recovery and produce a complete, nonzero report.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-benchmark-resume-"));
  const output = path.join(dir, "report.json"), checkpoint = output + ".state.json";
  const script = path.join(__dirname, "../scripts/benchmark-coding.js");
  const env = { ...process.env, OMNIWORK_OPENCODE_BIN: path.join(__dirname, "fixtures/fake-opencode.js"), OMNIWORK_NO_PREWARM: "1" };
  const start = args => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout.on("data", b => { log += b; }); child.stderr.on("data", b => { log += b; });
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve({ code, log })); });
    return { child, done };
  };
  let running, workspace;
  try {
    running = start(["--live", "--repeats", "1", "--cases", "output-paging", "--output", output]);
    let state;
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (fs.existsSync(checkpoint)) { state = JSON.parse(fs.readFileSync(checkpoint)); workspace = state.root; }
      if (state?.plans.every(p => p.id)) break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert(state?.plans.every(p => p.id), "Admission checkpoint was not created");
    const ids = state.plans.map(p => p.id);
    running.child.kill("SIGTERM");
    const interrupted = await running.done;
    assert.equal(interrupted.code, 1, interrupted.log);
    assert.equal(JSON.parse(fs.readFileSync(output)).complete, false);
    assert(fs.existsSync(checkpoint), "Interrupted evidence was removed");
    running = start(["--resume", output]);
    const resumed = await running.done;
    assert.equal(resumed.code, 1, resumed.log);
    const report = JSON.parse(fs.readFileSync(output));
    assert.equal(report.complete, true, resumed.log);
    assert.deepEqual(report.rows.map(r => r.id).sort(), ids.sort());
    assert(report.rows.every(r => !r.accepted));
    assert(!fs.existsSync(checkpoint)); assert(!fs.existsSync(workspace));
    console.log("✓ interrupted benchmark resumes the same jobs, retains failures, and cleans up only after completion");
  } finally {
    if (running?.child.exitCode === null) { running.child.kill("SIGTERM"); await running.done; }
    if (workspace && fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
