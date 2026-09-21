"use strict";

// One bounded queue for both in-loop workers and MCP delegations. Never drop jobs.
async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await run(items[i], i);
    }
  }));
  return results;
}

// Observed outcomes, not the model's description of what it intended to do.
async function executeTask({ task, createAgent, recover, checks = [], runCheck, repairAttempts = 0, maxTokens = Infinity, timeoutMs = 600_000, signal, progress = () => {}, trace = false, verificationReserveTokens = 0, verificationReserveMs = 0 }) {
  const started = Date.now();
  const telemetry = trace ? new (require("./execution-trace").ExecutionTrace)() : null;
  const controller = new AbortController();
  let agent, error = null, completed = false, timedOut = false, steps = 0, budgetReason = null;
  let turn = 0, inModelTurn = false, checkpointPromise = null, completionSource = "model";
  const checkpoint = { requested: false, confirmed: false, trigger: null };
  const reserveEnabled = checks.length > 0 && Boolean(runCheck) && (verificationReserveTokens > 0 || verificationReserveMs > 0);
  const requestCheckpoint = trigger => {
    if (!reserveEnabled || turn !== 1 || checkpoint.requested || !inModelTurn || controller.signal.aborted || error) return;
    if (agent?.isEngine && !agent.sessionID) return;
    checkpoint.requested = true; checkpoint.trigger = trigger;
    progress(++steps, "stopping engine for verification");
    checkpointPromise = Promise.resolve().then(() => agent.pauseForVerification()).then(ok => { checkpoint.confirmed = ok === true; return checkpoint.confirmed; }).catch(() => false);
  };
  const changes = [], calls = new Map(), attempts = [], verification = [];
  const checkHistory = [];
  const usage = { inTokens: 0, outTokens: 0, estimated: false, available: false };
  let lastUsage = { inTokens: 0, outTokens: 0 };
  const emit = (type, p) => {
    if (controller.signal.aborted) return;
    telemetry?.event(type, p, turn);
    if (verificationReserveMs > 0 && Date.now() - started >= timeoutMs - verificationReserveMs) requestCheckpoint("time");
    if (type === "subagent" && (p.kind === "tool_call" || p.kind === "tool_result")) {
      emit(p.kind, { ...p.payload, id: `${p.subId}:${p.payload.id}` });
      return;
    }
    if (type === "error") error = p.message || "Agent failed";
    if (type === "done") completed = true;
    if (type === "thinking") progress(++steps, "working");
    if (type === "tool_call") { calls.set(p.id, p); progress(steps, p.name); }
    if (type === "tool_result") {
      const call = calls.get(p.id);
      if (p.ok === true && call && /^(write_file|edit_file|write|edit|patch|apply_patch)$/.test(call.name)) {
        changes.push({ tool: call.name, path: call.args.path || call.args.filePath || call.args.file || null });
      }
    }
    if (type === "stats" || type === "done") {
      if (p.inTokens != null && p.outTokens != null) {
        usage.inTokens += Math.max(0, p.inTokens - lastUsage.inTokens);
        usage.outTokens += Math.max(0, p.outTokens - lastUsage.outTokens);
        for (const key of ["uncachedInTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "modelRequests"]) {
          if (Number.isFinite(p[key])) usage[key] = (usage[key] || 0) + Math.max(0, p[key] - (lastUsage[key] || 0));
        }
        lastUsage = p;
        usage.available = true;
      }
      usage.estimated ||= Boolean(p.estimated);
      if (usage.available && usage.inTokens + usage.outTokens >= maxTokens) { budgetReason = "Observed token budget reached"; cancel(); }
      else if (verificationReserveTokens > 0 && usage.available && usage.inTokens + usage.outTokens >= maxTokens - verificationReserveTokens) requestCheckpoint("tokens");
    }
  };
  let unblock;
  const cancelled = new Promise((r) => { unblock = r; });
  const cancel = () => { controller.abort(); agent?.abort(); unblock(); };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  const reserveTimer = reserveEnabled && verificationReserveMs > 0 ? setTimeout(() => requestCheckpoint("time"), Math.max(1, timeoutMs - verificationReserveMs)) : null;
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const send = async prompt => {
    turn++; inModelTurn = true;
    try { await agent.send(prompt); } finally { inModelTurn = false; }
  };
  const work = async () => {
    if (controller.signal.aborted) return;
    agent = await createAgent(emit, controller.signal);
    if (controller.signal.aborted) { agent.abort(); return; }
    if (reserveEnabled && typeof agent.pauseForVerification !== "function") throw new Error("This agent cannot confirm a safe verification checkpoint");
    const attempt = { model: agent.model, error: null };
    attempts.push(attempt);
    await send(task);
    if (checkpointPromise) {
      const confirmed = await checkpointPromise;
      if (controller.signal.aborted) return;
      if (!confirmed) { error ||= "Engine stop could not be confirmed; verification skipped"; completed = false; }
      else if (!error) { completed = true; completionSource = "checkpoint"; }
    }
    Object.assign(attempt, { model: agent.effectiveModel || agent.model, error });
    // Recovery is safe only before any tools were attempted. Otherwise retrying
    // a task from scratch can duplicate side effects.
    if (error && !calls.size && recover && !controller.signal.aborted) {
      const next = await recover(error, agent, emit, controller.signal);
      if (next) {
        agent = next; error = null; completed = false; lastUsage = { inTokens: 0, outTokens: 0 };
        const retry = { model: agent.model, error: null };
        attempts.push(retry);
        await send(task);
        Object.assign(retry, { model: agent.effectiveModel || agent.model, error });
      }
    }
    if (!error && completed && runCheck) {
      for (let round = 0; round <= repairAttempts; round++) {
        verification.length = 0;
        for (const command of checks) {
          if (controller.signal.aborted) return;
          const checkStarted = Date.now();
          const result = await runCheck(command, controller.signal);
          if (telemetry) telemetry.verificationMs += Date.now() - checkStarted;
          if (controller.signal.aborted) return;
          verification.push({ command, ok: result.ok, exitCode: result.exitCode, output: result.text.slice(-8000) });
        }
        if (!verification.some(c => !c.ok)) break;
        checkHistory.push({ round, checks: verification.slice() });
        if (round === repairAttempts) { error = "Acceptance check failed"; break; }
        progress(++steps, `repair ${round + 1}: acceptance checks failed`);
        completed = false; lastUsage = { inTokens: 0, outTokens: 0 };
        const repair = { model: agent.model, phase: "repair", error: null }; attempts.push(repair);
        const evidence = verification.filter(c => !c.ok).map(c => `${c.command}\n${c.output}`).join("\n\n").slice(-12000);
        await send(`Acceptance checks failed. Repair the implementation in this existing workspace; preserve the original task and ownership constraints. Do not weaken, delete or bypass tests.\n\n${evidence}`);
        completionSource = "model";
        repair.error = error;
        if (error || !completed || controller.signal.aborted) break;
      }
    }
  };
  try {
    await Promise.race([work().catch(e => { error = e.message; }), cancelled]);
  } finally {
    clearTimeout(timer); clearTimeout(reserveTimer); signal?.removeEventListener("abort", cancel);
  }
  const stopped = budgetReason || (timedOut ? "Task deadline exceeded" : controller.signal.aborted ? "Cancelled by caller" : error || (!completed ? "Agent stopped without a completion event" : null));
  if (stopped && attempts.length) attempts[attempts.length - 1].error ||= stopped;
  const status = controller.signal.aborted ? (timedOut || budgetReason ? "partial" : "cancelled") : stopped ? (changes.length ? "partial" : "failed") : "completed";
  return {
    status, reason: stopped, summary: agent?.lastText || (status === "completed" && completionSource === "checkpoint" ? "Acceptance checks passed after a confirmed engine stop." : ""), changes, attempts, toolCalls: calls.size, checkHistory,
    ...(reserveEnabled ? { completion: { source: completionSource, checkpoint: { ...checkpoint } } } : {}),
    ...(telemetry ? { trace: telemetry.snapshot() } : {}),
    model: agent?.effectiveModel || agent?.model || null, verification: { status: verification.length ? (verification.every(c => c.ok) ? "passed" : "failed") : "unverified", checks: verification },
    usage: usage.available ? usage : { inTokens: null, outTokens: null, estimated: true, available: false }, elapsedMs: Date.now() - started,
  };
}

function formatResult(r) {
  return `[status: ${r.status}]${r.reason ? " " + r.reason : ""}\n${r.summary || "(no summary)"}`
    + (r.changes.length ? "\n\nChanges:\n" + r.changes.map(c => `- ${c.tool}: ${c.path || "see workspace diff"}`).join("\n") : "")
    + `\n\n[model: ${r.model || "unavailable"}]\n[verify: ${r.verification.status}]`
    + r.verification.checks.map(c => `\n${c.ok ? "PASS" : "FAIL"}: ${c.command}\n${c.output}`).join("");
}

module.exports = { mapLimit, executeTask, formatResult };
