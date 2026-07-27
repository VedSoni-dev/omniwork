// Unit test: compaction preserves the system prompt and recent turns, never
// orphans a tool result, shrinks the estimate, and degrades gracefully when
// the summarize call fails. No gateway needed.
const { estimateTokens, shouldCompact, cutIndex, compact, SUMMARY_MARKER, DEFAULT_CONTEXT } = require("../electron/compactor");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

// Synthetic session: system + 20 turns of user → assistant(tool_calls) → tool → assistant
const messages = [{ role: "system", content: "You are OmniWork." }];
for (let i = 0; i < 20; i++) {
  messages.push({ role: "user", content: `Task ${i}: ` + "x".repeat(3000) });
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "echo " + i }) } }] });
  messages.push({ role: "tool", tool_call_id: `call_${i}`, content: "out ".repeat(500) });
  messages.push({ role: "assistant", content: `Done with task ${i}.` });
}

check("estimate is nonzero and plausible", estimateTokens(messages) > 20_000);
check("shouldCompact false under budget", !shouldCompact(messages, 10_000_000));
check("shouldCompact true over budget", shouldCompact(messages, 30_000));
check("cut lands on a user message", messages[cutIndex(messages)].role === "user");

(async () => {
  const before = estimateTokens(messages);
  const { messages: out, note } = await compact(messages, async () => "The user completed tasks 0-13.");

  check("system prompt survives", out[0].role === "system" && out[0].content === "You are OmniWork.");
  check("summary message injected with marker", out[1].role === "user" && out[1].content.startsWith(SUMMARY_MARKER) && out[1].content.includes("tasks 0-13"));
  check("recent turns kept verbatim", out.some((m) => m.content === "Done with task 19."));
  check("estimate shrinks", estimateTokens(out) < before / 2);
  check("note reports the shrink", /Compacted \d+ older messages/.test(note));

  // No orphaned tool results: every tool message's call id must exist in a prior assistant message.
  const seen = new Set();
  let orphans = 0;
  for (const m of out) {
    for (const tc of m.tool_calls || []) seen.add(tc.id);
    if (m.role === "tool" && !seen.has(m.tool_call_id)) orphans++;
  }
  check("no orphaned tool results", orphans === 0);

  // Failure path: summarize throws → truncation notice, same structural guarantees.
  const { messages: fb, note: fbNote } = await compact(messages, async () => { throw new Error("gateway down"); });
  check("failure still compacts (truncation)", fb[1].content.startsWith(SUMMARY_MARKER) && fb[1].content.includes("truncated"));
  check("failure still returns a note", !!fbNote);

  // Short conversation: nothing to do.
  const short = [{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
  const { messages: same, note: none } = await compact(short, async () => "irrelevant");
  check("short conversation untouched", same === short && none === null);

  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ COMPACTION TEST PASSED");
  process.exit(fails ? 1 : 0);
})();
