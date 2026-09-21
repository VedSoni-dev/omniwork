"use strict";
const client = require("./job-client");
const strings = { type: "array", items: { type: "string" } };
const properties = {
  task: { type: "string", description: "Self-contained task and required behavior." },
  cwd: { type: "string", description: "Absolute project directory; defaults to the submission cwd." },
  model: { type: "string", description: "Optional concrete model ID. Omit for managed free-model selection." },
  engine_profile: { type: "string", enum: ["standard", "scoped", "focused"], description: "Standard (default) preserves the full OpenCode agent and skills. Scoped keeps model-specific instructions with local coding tools and no automatic skills catalog. Focused also substitutes a compact experimental prompt. Scoped/focused conversations allow up to 24 steps." },
  policy: { type: "string", enum: ["free_only", "allow_paid"], description: "Default free_only. allow_paid requires an explicit model; no automatic paid fallback." },
  checks: { ...strings, maxItems: 10, description: "Acceptance commands. Required to apply an isolated patch." },
  setup: { ...strings, maxItems: 4, description: "Optional dependency/setup commands in the isolated workspace; also run for integration checks." },
  allowed_paths: { ...strings, maxItems: 100, description: "Owned relative files or directory prefixes ending in /. Edits outside these paths block application." },
  context_files: { ...strings, maxItems: 20, description: "Relevant relative files included as bounded excerpts, so workers need less exploration." },
  isolation: { type: "string", enum: ["worktree", "shared"], description: "Default worktree snapshots current Git changes. shared edits the original directory directly." },
  timeout_ms: { type: "integer", minimum: 1000, maximum: 1800000, description: "Total job deadline, including setup, verification and repair; default 180000." },
  max_tokens: { type: "integer", minimum: 1000, maximum: 2000000, description: "Stop after observed input/output usage reaches this budget; an in-flight request can overshoot. Default 200000." },
  max_steps: { type: "integer", minimum: 1, maximum: 80, description: "Native agent step limit per turn; default 24. Engine jobs use deadline/token controls." },
  repair_attempts: { type: "integer", minimum: 0, maximum: 3, description: "Same-worker repairs after acceptance failure, default 1; within the original deadline and token budget." },
  verification_reserve_tokens: { type: "integer", minimum: 0, maximum: 1000000, description: "Opt-in: stop the initial engine turn this many observed tokens before the hard cap, confirm idle, then verify and optionally repair. Requires pinned OpenCode model, scoped/focused profile, isolated worktree and checks. Default 0; an in-flight request may overshoot." },
  verification_reserve_ms: { type: "integer", minimum: 0, maximum: 900000, description: "Opt-in time reserved within the original deadline for confirmed-stop verification and repair. Same restrictions as verification_reserve_tokens. Default 0; neither reserve raises the hard limits." },
};
const id = { type: "string", description: "Durable job ID returned by jobs_submit." };
const TOOLS = [
  { name: "jobs_submit", description: "Submit independent coding tasks to OmniWork's shared durable worker service and return IDs immediately. Workers use isolated Git snapshots, managed capacity, and free-only selection by default. Supply owned paths and checks. Jobs survive client disconnects. Use request_id to deduplicate retries; use jobs_wait for results and jobs_apply for verified patches.", inputSchema: { type: "object", properties: {
    cwd: properties.cwd, tasks: { type: "array", minItems: 1, maxItems: 100, items: { anyOf: [{ type: "string" }, { type: "object", properties, required: ["task"] }] } },
    defaults: { type: "object", properties }, request_id: { type: "string", description: "Stable unique batch key for safe retry. Reusing it with different tasks is rejected." },
  }, required: ["cwd", "tasks"] } },
  { name: "jobs_wait", description: "Wait up to 25 seconds for the first terminal job, or for a revision change when after_revision is supplied. Returns compact results and a revision cursor. Waiting does not cancel jobs on client disconnect; use jobs_cancel explicitly. Prefer this to repeated polling.", inputSchema: { type: "object", properties: { ids: { ...strings, minItems: 1, maxItems: 100 }, after_revision: { type: "integer", minimum: 0 }, timeout_ms: { type: "integer", minimum: 0, maximum: 25000 } }, required: ["ids"] } },
  { name: "jobs_get", description: "Inspect a durable job's status, evidence, usage, workspace and patch. Compact by default; detail=true includes the full task contract, attempts, acceptance output and repair history. Use jobs_read for large patch or result artifacts.", inputSchema: { type: "object", properties: { id, detail: { type: "boolean" } }, required: ["id"] } },
  { name: "jobs_list", description: "Recover job IDs after reconnecting, or inspect the shared worker backlog. Lists recent jobs with compact status and evidence, supports status filtering and pagination, and does not start new model work.", inputSchema: { type: "object", properties: { status: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } } } },
  { name: "jobs_read", description: "Read a bounded page from a job's patch, execution result or metadata-only request/tool trace. Follow next_offset when more content is needed.", inputSchema: { type: "object", properties: { id, artifact: { type: "string", enum: ["patch", "result", "trace"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 24000 } }, required: ["id"] } },
  { name: "jobs_cancel", description: "Explicitly cancel a queued or active durable job. Active workers and their shell commands are signalled to stop. Isolated work and evidence are retained for inspection; already terminal jobs are unchanged.", inputSchema: { type: "object", properties: { id }, required: ["id"] } },
  { name: "jobs_apply", description: "Apply a completed isolated job's verified patch to its original workspace. Requires passing checks and owned-path compliance. Rejects overlapping source edits, reruns checks against a fresh integration snapshot, and preserves the user's Git index and branch. This changes source files.", inputSchema: { type: "object", properties: { id }, required: ["id"] } },
  { name: "jobs_status", description: "Inspect global worker capacity, provider concurrency, native-request pacing, cooldowns and completion counts. Use when jobs are queued or blocked; capacity limits are shared across clients of this service.", inputSchema: { type: "object", properties: {} } },
];
function submission(args) {
  if (!Array.isArray(args.tasks)) throw new Error("tasks must be an array");
  return { request_id: args.request_id, tasks: args.tasks.map(t => ({ ...(args.defaults || {}), cwd: args.cwd, ...(typeof t === "string" ? { task: t } : t) })) };
}
function call(name, args, signal) {
  const method = name.slice(5);
  return client.call(method === "status" ? "stats" : method, method === "submit" ? submission(args) : args, { signal, timeout: method === "apply" ? 900000 : 30000 });
}
module.exports = { TOOLS, submission, call };
