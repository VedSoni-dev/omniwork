#!/usr/bin/env node
"use strict";
// Real installed engine, synthetic LOCAL inference: does a Harness² harness
// reach the model the way it should? Checks the request OpenCode actually
// sends — always-on text appended to the provider prompt, repository rules
// kept, harness skills and subagents offered, the user's global skills not —
// and that a tool round trip lands in the trajectory. Saves no prompt text.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { executeTask } = require("../electron/execution");
const engineHarness = require("../electron/engine-harness");
const opencode = require("../electron/opencode-engine");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-harness-probe-"));
const workspace = path.join(root, "ws"), harnessDir = path.join(root, "harness");
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const b = JSON.parse(raw || "{}");
  const system = (b.messages || []).filter(m => ["system", "developer"].includes(m.role)).map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
  const tool = name => JSON.stringify((b.tools || []).find(t => t.function?.name === name) || "");
  requests.push({ tools: (b.tools || []).map(t => t.function?.name), harnessText: system.includes("HARNESS_PROBE_MARKER"), repoRule: system.includes("REPO_PROBE_MARKER"),
    // OpenCode 1.18 lists skills in the system prompt and subagents in the task tool.
    harnessSkill: (system + tool("skill")).includes("A probe skill."), harnessAgent: tool("task").includes("probe-reader"),
    userSkills: ["autoplan", "agents-sdk", "design-shotgun", "land-and-deploy"].filter(s => (system + tool("skill")).includes(s)) });
  const first = requests.length === 1;
  const chunk = delta => ({ id: "probe", object: "chat.completion.chunk", created: 1, model: "coder", choices: [{ index: 0, delta, finish_reason: null }] });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (first) res.write("data: " + JSON.stringify(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: path.join(workspace, "AGENTS.md") }) } }] })) + "\n\n");
  else res.write("data: " + JSON.stringify(chunk({ role: "assistant", content: "READY" })) + "\n\n");
  res.write("data: " + JSON.stringify({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } }) + "\n\n");
  res.end("data: [DONE]\n\n");
});
(async () => {
  write(path.join(workspace, "AGENTS.md"), "REPO_PROBE_MARKER\n");
  write(path.join(harnessDir, "systemprompt.md"), "HARNESS_PROBE_MARKER\nWhen a probe needs it, load the `probe-skill` skill.\n");
  write(path.join(harnessDir, "skills/probe-skill/SKILL.md"), "---\nname: probe-skill\ndescription: A probe skill.\n---\nbody\n");
  write(path.join(harnessDir, "sub_agents/probe-reader/AGENT.md"), "---\ndescription: A probe subagent.\nmode: subagent\n---\nbody\n");
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ enabled_providers: ["fixture"], small_model: "fixture/coder", provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Local fixture", options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture" }, models: { coder: { name: "Local fixture", limit: { context: 100000, output: 2048 }, tool_call: true } } } } });
  const staged = engineHarness.stage(engineHarness.read(harnessDir), path.join(root, "staged"));
  const result = await executeTask({ task: "Read AGENTS.md, then reply READY.", trajectory: true, timeoutMs: 120000,
    createAgent: async emit => { const a = new opencode.OpenCodeAgent({ workspace, model: "opencode/fixture/coder", engineProfile: "harness", harness: staged, emit }); await a.engine.models(); return a; } });
  const lines = result.trajectory.entries;
  const report = { scope: "Real OpenCode HTTP requests to a local synthetic inference server", engineVersion: opencode.version(), status: result.status, requests,
    trajectory: { types: lines.map(e => e.type), toolCompleted: lines.some(e => e.type === "tool" && e.part.tool === "read" && e.part.state.status === "completed" && String(e.part.state.output).includes("REPO_PROBE_MARKER")) } };
  const problems = [];
  if (result.status !== "completed") problems.push(`execution ${result.status}: ${result.reason}`);
  if (!requests.length) problems.push("no request reached the model");
  for (const [i, r] of requests.entries()) {
    if (!r.harnessText) problems.push(`request ${i}: harness always-on text missing`);
    if (!r.repoRule) problems.push(`request ${i}: repository AGENTS.md missing`);
    if (!r.harnessSkill) problems.push(`request ${i}: harness skill not offered`);
    if (!r.harnessAgent) problems.push(`request ${i}: harness subagent not offered`);
    if (r.userSkills.length) problems.push(`request ${i}: global skills leaked: ${r.userSkills.join(", ")}`);
  }
  if (!report.trajectory.toolCompleted) problems.push("trajectory has no completed read with its output");
  const i = process.argv.indexOf("--trajectory"); if (i >= 0) fs.writeFileSync(process.argv[i + 1], lines.map(e => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { opencode.stopAll(); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
