"use strict";
// Deterministic payload/fidelity benchmark, not an end-to-end model benchmark.
const assert = require("node:assert/strict");
const { ToolOutputStore } = require("../electron/tool-output");
const { compact, estimateTokens } = require("../electron/compactor");
(async () => {
  const raw = Array.from({ length: 200 }, (_, i) => `src/handler${i}.js: // preserve contract ${i}\nfunction handle${i}() { return "answer-${i}"; }\n` + "// relevant source comment\n".repeat(5)).join("\n");
  const store = new ToolOutputStore();
  const initial = store.capture(raw);
  const id = /id=([a-f0-9-]+)/.exec(initial)[1];
  const extra = store.read(id, raw.indexOf("src/handler150.js:"), 1000);
  assert(initial.includes('function handle7() { return "answer-7"; }'));
  assert(extra.includes('function handle150() { return "answer-150"; }'));
  assert(extra.includes("preserve contract 150"));
  const history = [{ role: "system", content: "coding agent" }, { role: "user", content: "Implement the task and preserve the public API." }];
  for (let i = 0; i < 30; i++) history.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, function: { name: "read_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(48000) });
  const reduced = await compact(history, async () => "Files were inspected; continue implementing the original task.");
  console.log(JSON.stringify({
    scope: "Synthetic payload estimate (chars/4); no provider or model-quality measurement",
    output: { originalTokens: Math.ceil(raw.length/4), initialAndRetrievedTokens: Math.ceil((initial.length+extra.length)/4), bothRequestedSymbolsAndCommentsPreserved: true },
    context: { beforeTokens: estimateTokens(history), afterTokens: estimateTokens(reduced.messages), originalTaskPreserved: reduced.messages[1].content.includes("preserve the public API") },
  }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
