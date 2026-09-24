"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const suites = ["tuning", "compact", "fallback", "providers", "opencode", "acp", "mcp", "modes", "approvals", "persist", "sidecar", "reliability", "jobs", "jobs-daemon", "coding-benchmark", "execution-trace"];
let failed = false;
for (const suite of suites) {
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "test", suite + ".js")], { encoding: "utf8", timeout: 120_000, env: { ...process.env, OMNIWORK_NO_PREWARM: "1", OMNIWORK_MODEL: "", OMNIWORK_MODEL_FALLBACKS: "" } });
  const ok = run.status === 0 && !run.error;
  console.log(`${ok ? "PASS" : "FAIL"} ${suite}`);
  if (!ok) { console.error(run.error || "", run.stdout, run.stderr); failed = true; }
}
process.exitCode = failed ? 1 : 0;
