"use strict";
const assert = require("node:assert/strict");
const { ExecutionTrace } = require("../electron/execution-trace");
const { executeTask } = require("../electron/execution");
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const trace = new ExecutionTrace();
  trace.event("request", { id: "m", startedAt: 100, model: "provider/model" }, 1);
  const tokens = { input: 20, output: 5, reasoning: 2, cache: { read: 40, write: 0 } };
  for (let i = 0; i < 3; i++) trace.event("request", { id: "m", completedAt: 150, tokens }, 1);
  for (let i = 0; i < 2; i++) {
    trace.event("tool_call", { id: "c" + i, name: "read", requestId: "m", args: { filePath: "/private/SECRET", offset: 1 }, startedAt: 151 }, 1);
    trace.event("tool_result", { id: "c" + i, ok: true, result: "PRIVATE_CONTENT", outputBytes: 200, completedAt: 160 }, 1);
  }
  const t = trace.snapshot();
  assert.equal(t.requests.length, 1); assert.equal(t.requests[0].usage.input, 20);
  assert.equal(t.requests[0].usage.cacheRead, 40); assert.equal(t.summary.repeatedReads, 1);
  assert.equal(t.summary.toolOutputBytes, 400); assert.equal(t.summary.cumulativeAssistantMs, 50);
  assert.equal(t.tools[0].request, t.requests[0].id);
  assert(!/SECRET|PRIVATE_CONTENT|filePath/.test(JSON.stringify(t)));
  const other = new ExecutionTrace();
  other.event("tool_call", { id: "x", name: "read", args: { offset: 1, filePath: "/private/SECRET" } }, 1);
  assert.notEqual(other.snapshot().tools[0].fingerprint, t.tools[0].fingerprint);
  trace.event("request", { id: "m", tokens }, 2);
  assert.equal(trace.snapshot().requests.length, 2);
  const bounded = new ExecutionTrace({ limit: 1 });
  bounded.event("request", {}, 1); bounded.event("request", { id: "a" }, 1); bounded.event("request", { id: "b" }, 1);
  assert.equal(bounded.snapshot().requests.length, 1); assert.equal(bounded.snapshot().summary.discardedEvents, 1);
  assert.equal(bounded.snapshot().summary.cumulativeAssistantMs, null);
  bounded.event("request", { id: "a", failed: true, tokens: { input: 0, output: 0 } }, 1);
  assert.equal(bounded.snapshot().summary.requestsWithUsage, 0, "initialized zero usage must not look like free inference");
  console.log("✓ traces merge request updates, retain unknown timing, bound growth and omit sensitive content");

  async function scenario({ stopConfirmed = true, providerError = false, hardOvershoot = false, failCheck = false, cancelDuringStop = false, reserve = true } = {}) {
    let sends = 0, checks = 0, active = false, stopped = false, event;
    const ctl = new AbortController();
    const result = await executeTask({ task: "fix", trace: true, checks: ["verify"], repairAttempts: 1,
      maxTokens: 1000, timeoutMs: 2000, verificationReserveTokens: reserve ? 300 : 0, signal: ctl.signal,
      createAgent: async emit => {
        event = emit;
        return { model: "fixture", lastText: "", abort() { active = false; },
          async pauseForVerification() {
            if (cancelDuringStop) ctl.abort();
            await delay(10); stopped = true; active = false; return stopConfirmed;
          },
          async send() {
            sends++; active = true;
            emit("request", { id: "request", tokens: { input: sends === 1 ? 700 : 20, output: 1 } });
            emit("stats", { inTokens: hardOvershoot ? 1001 : sends === 1 ? 700 : 20, outTokens: 1 });
            if (providerError) emit("error", { message: "upstream rejected request" });
            await delay(20); active = false;
            if (!reserve || sends > 1) emit("done", { inTokens: sends === 1 ? 700 : 20, outTokens: 1 });
          },
        };
      },
      runCheck: async () => { checks++; assert(!active, "verification raced a writer"); if (reserve) assert(stopped); return { ok: !failCheck || sends === 2, exitCode: failCheck && sends === 1 ? 1 : 0, text: "check evidence" }; },
    });
    // Late events from stopped work cannot turn cancellation into acceptance.
    if (cancelDuringStop || hardOvershoot) event("done", { inTokens: 0, outTokens: 0 });
    return { result, sends, checks };
  }
  let x = await scenario(); assert.equal(x.result.status, "completed"); assert.equal(x.result.completion.source, "checkpoint"); assert.equal(x.sends, 1);
  x = await scenario({ stopConfirmed: false }); assert.notEqual(x.result.status, "completed"); assert.equal(x.checks, 0);
  x = await scenario({ providerError: true }); assert.notEqual(x.result.status, "completed"); assert.equal(x.checks, 0); assert.match(x.result.reason, /upstream/);
  x = await scenario({ hardOvershoot: true }); assert.equal(x.result.status, "partial"); assert.equal(x.checks, 0);
  x = await scenario({ cancelDuringStop: true }); assert.equal(x.result.status, "cancelled"); assert.equal(x.checks, 0);
  x = await scenario({ failCheck: true }); assert.equal(x.result.status, "completed"); assert.equal(x.sends, 2); assert.equal(x.result.usage.inTokens, 720); assert.equal(x.result.checkHistory.length, 1); assert.equal(x.result.trace.requests.length, 2);
  x = await scenario({ reserve: false }); assert.equal(x.result.status, "completed"); assert.equal(x.result.completion, undefined);
  let repairTurns = 0, repairPauses = 0;
  const normalRepair = await executeTask({ task: "fix", maxTokens: 1000, verificationReserveTokens: 300, checks: ["verify"], repairAttempts: 1,
    createAgent: async emit => ({ abort() {}, async pauseForVerification() { repairPauses++; return true; }, async send() {
      repairTurns++; const usage = { inTokens: repairTurns === 1 ? 100 : 750, outTokens: 0 }; emit("stats", usage); emit("done", usage);
    } }),
    runCheck: async () => ({ ok: repairTurns === 2, exitCode: repairTurns === 2 ? 0 : 1, text: "repair required" }),
  });
  assert.equal(normalRepair.status, "completed"); assert.equal(repairPauses, 0, "reserves may only interrupt the initial turn");
  let checks = 0;
  const timeout = await executeTask({ task: "fix", maxTokens: 1000, timeoutMs: 50, verificationReserveTokens: 300, checks: ["test"],
    createAgent: async emit => ({ abort() {}, pauseForVerification: async () => true, async send() { emit("stats", { inTokens: 750, outTokens: 0 }); } }),
    runCheck: async () => { checks++; await delay(100); return { ok: true, exitCode: 0, text: "late" }; },
  });
  assert.equal(checks, 1); assert.equal(timeout.status, "partial"); assert.match(timeout.reason, /deadline/);
  console.log("✓ checkpoints require confirmed stop, preserve errors/cancellation/hard budgets, and repair in the same agent");
})().catch(e => { console.error(e); process.exitCode = 1; });
