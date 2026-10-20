"use strict";
// Opt-in content trajectories: what the collector records from agent events,
// that executeTask only keeps one when asked, and that the job service stores
// it owner-only and pages it back.
//
// Run: node test/execution-trajectory.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExecutionTrajectory, FIELD } = require("../electron/execution-trajectory");
const { executeTask } = require("../electron/execution");
const { JobService, TERMINAL } = require("../electron/job-service");

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log("✓", name); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-trajectory-"));
let service;

(async () => {
  await check("streamed text, reasoning and tool calls become OpenCode-shaped parts in order", () => {
    const t = new ExecutionTrajectory();
    t.prompt("Fix the bug", 1);
    t.event("reasoning_delta", { chunk: "think " }, 1); t.event("reasoning_delta", { chunk: "more" }, 1);
    t.event("assistant_delta", { chunk: "Look" }, 1); t.event("assistant_delta", { chunk: "ing." }, 1);
    t.event("tool_call", { id: "c1", name: "read", args: { filePath: "a.js" } }, 1);
    t.event("tool_result", { id: "c1", name: "read", ok: true, result: "const a = 1;" }, 1);
    t.event("tool_call", { id: "c2", name: "bash", args: { command: "node test.js" } }, 1);
    t.event("tool_result", { id: "c2", name: "bash", ok: false, result: "exit 1", exitCode: 1 }, 1);
    t.event("assistant_delta", { chunk: "Done." }, 1);
    t.event("assistant", { content: "Looking.Done." }, 1);
    const { entries, summary } = t.snapshot();
    assert.deepEqual(entries.map(e => e.type), ["user", "reasoning", "text", "tool", "tool", "text"]);
    assert.equal(entries[1].part.text, "think more"); assert.equal(entries[2].part.text, "Looking.");
    assert.deepEqual(entries[3].part.state, { status: "completed", input: { filePath: "a.js" }, output: "const a = 1;" });
    assert.deepEqual(entries[4].part.state, { status: "error", input: { command: "node test.js" }, error: "exit 1", exitCode: 1 });
    assert.equal(entries[5].part.text, "Done.", "a streamed reply is not recorded twice");
    assert.deepEqual(summary, { entries: 6, tools: 2, dropped: 0, truncated: 0 });
  });
  await check("non-streaming agents' replies and errors are recorded; oversized fields are clipped and counted", () => {
    const t = new ExecutionTrajectory({ limit: 3 });
    t.event("assistant", { content: "native reply" }, 1);
    t.event("tool_call", { id: "w", name: "write_file", args: { path: "big", content: "x".repeat(FIELD + 10) } }, 1);
    t.event("tool_result", { id: "w", name: "write_file", result: "y".repeat(FIELD + 10) }, 1);
    t.event("error", { message: "Reached max steps" }, 1);
    t.event("system", { content: "over the limit" }, 1);
    const { entries, summary } = t.snapshot();
    assert.equal(entries[0].part.text, "native reply");
    assert(entries[1].part.state.input.truncated.endsWith("chars)") && entries[1].part.state.output.length < FIELD + 40);
    assert.deepEqual(entries[2].error, { message: "Reached max steps" });
    assert.deepEqual([summary.dropped, summary.truncated], [1, 2]);
  });
  let sends = 0;
  const agent = async emit => ({ model: "fixture", lastText: "", abort() {}, async send(prompt) {
    sends++;
    emit("tool_call", { id: "t" + sends, name: "bash", args: { command: "node check.js" } });
    emit("tool_result", { id: "t" + sends, name: "bash", ok: true, result: sends === 1 ? "wrong" : "right" });
    emit("assistant", { content: `turn ${sends}` });
    emit("done", { inTokens: 10, outTokens: 1 });
  } });
  const result = await executeTask({ task: "implement it", trajectory: true, checks: ["check"], repairAttempts: 1, createAgent: agent,
    runCheck: async () => ({ ok: sends > 1, exitCode: sends > 1 ? 0 : 1, text: "expected right" }) });
  await check("executeTask records the task, each turn and the repair prompt only when asked", async () => {
    const types = result.trajectory.entries.map(e => `${e.turn}:${e.type}`);
    assert.deepEqual(types, ["1:user", "1:tool", "1:text", "2:user", "2:tool", "2:text"]);
    assert.equal(result.trajectory.entries[0].part.text, "implement it");
    assert.match(result.trajectory.entries[3].part.text, /Acceptance checks failed[\s\S]*expected right/);
    sends = 0;
    const plain = await executeTask({ task: "x", createAgent: agent });
    assert.equal(plain.trajectory, undefined, "no content is kept by default");
  });
  await check("the job service writes trajectory.jsonl owner-only and pages it", async () => {
    const repo = path.join(root, "repo"); fs.mkdirSync(repo);
    service = new JobService({ dir: path.join(root, "store"), catalog: async () => [{ id: "local/coder", provider: "local", free: true, tools: true }],
      runCheck: async () => ({ ok: true, exitCode: 0, text: "" }),
      run: async opts => ({ status: "completed", reason: null, summary: "done", changes: [], attempts: [], toolCalls: 1, usage: { inTokens: 1, outTokens: 1, available: true }, verification: { status: "unverified", checks: [] },
        ...(opts.trajectory ? { trajectory: result.trajectory } : {}) }) });
    const [kept, plain] = service.submit({ tasks: [{ cwd: repo, task: "a", model: "local/coder", isolation: "shared", trajectory: true }, { cwd: repo, task: "b", model: "local/coder", isolation: "shared" }] }).jobs;
    for (const id of [kept.id, plain.id]) { const until = Date.now() + 10000; while (!TERMINAL.has(service.job(id).status)) { if (Date.now() > until) throw Error("job timed out"); await new Promise(r => setTimeout(r, 20)); } }
    const file = path.join(root, "store", kept.id, "trajectory.jsonl");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(lines.length, 6); assert.equal(lines[1].part.tool, "bash");
    assert.deepEqual(service.get(kept.id).trajectory, result.trajectory.summary);
    assert.equal(service.job(kept.id).result.trajectory, undefined, "content stays out of result.json");
    const page = await service.read({ id: kept.id, artifact: "trajectory", limit: 50 });
    assert.equal(page.text.length, 50); assert(page.next_offset);
    await assert.rejects(service.read({ id: plain.id, artifact: "trajectory" }), /not available/);
    assert.throws(() => service.submit({ tasks: [{ cwd: repo, task: "c", trajectory: "yes" }] }), /trajectory must be a boolean/);
  });
  console.log(`\n✅ EXECUTION TRAJECTORY TEST PASSED (${passed} checks)`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await service?.stop(); fs.rmSync(root, { recursive: true, force: true }); });
