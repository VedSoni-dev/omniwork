"use strict";
// Supported OpenCode agent configuration, scoped to explicitly selected workers.
const NAME = "omniwork-worker";
const CORE = ["read", "edit", "write", "apply_patch", "bash", "glob", "grep", "list"];
const PROMPT = `You are a focused coding worker in an existing repository. Complete the caller's task and follow the repository's instructions.
Inspect relevant source before editing. Use the supplied file context and paths to avoid broad exploration. Search narrowly and read only needed ranges. Make cohesive changes within the caller's ownership; preserve unrelated work and public behavior. Do not weaken tests to make them pass.
Use local tools directly. Batch independent reads and small related edits when practical. Keep command output bounded; inspect additional output when needed. Run the specified acceptance checks, diagnose failures, and fix the implementation within the available steps. Never claim a check passed without running it. Do not commit or publish unless requested.
Finish with a brief statement of changes, checks actually run, and unresolved issues.`;
function config({ compact = true } = {}) {
  return { description: "Focused local coding worker with bounded steps", mode: "primary", hidden: true,
    ...(compact ? { prompt: PROMPT } : {}), steps: 24, permission: { "*": "deny", ...Object.fromEntries(CORE.map(k => [k, "allow"])), external_directory: "allow" } };
}
function permissions(mode) {
  const action = mode === "auto" ? "allow" : "ask";
  const edits = ["edit", "write", "apply_patch"];
  return [{ permission: "*", pattern: "*", action: "deny" },
    ...CORE.map(permission => ({ permission, pattern: "*", action: ["read", "glob", "grep", "list"].includes(permission) ? "allow" : mode === "plan" ? "deny" : mode === "edits" && edits.includes(permission) ? "allow" : action })),
    { permission: "external_directory", pattern: "*", action }];
}
const SCOPED_NAME = "omniwork-scoped";
module.exports = { NAME, SCOPED_NAME, CORE, PROMPT, config, permissions };
