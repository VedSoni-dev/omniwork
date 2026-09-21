"use strict";
// Context compaction: keep long sessions inside the model's context window the
// way Claude Code does. When the estimated token count crosses the threshold,
// everything before the last few turns is summarized into a single message.
// Pure functions — the agent supplies the summarize call.

const DEFAULT_CONTEXT = 100_000; // tokens; conservative when the model is unknown
const COMPACT_AT = 0.8;          // auto-compact at 80% of budget
const KEEP_TURNS = 6;            // recent user turns kept verbatim
const MAX_SUMMARY_INPUT = 48_000; // chars fed to the summarize call

const SUMMARY_MARKER = "[Conversation summary — earlier context was compacted]";
const TASK_MARKER = "\n\nOriginal task (preserve its constraints):\n";

// chars/4 is a good-enough estimate; no tokenizer dependency.
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) for (const c of m.content) chars += (c.text || c.image_url ? (c.text || "").length + 1000 : 0);
    for (const tc of m.tool_calls || []) chars += (tc.function?.name || "").length + (tc.function?.arguments || "").length;
  }
  return Math.ceil(chars / 4);
}

function shouldCompact(messages, budget = DEFAULT_CONTEXT) {
  return estimateTokens(messages) > budget * COMPACT_AT;
}

// Index of the user message starting the Nth-from-last turn. Cutting at a user
// message keeps assistant tool_calls and their tool results together — a tool
// result can never be orphaned from its call.
function cutIndex(messages, keepTurns = KEEP_TURNS) {
  let turns = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === "user" && ++turns >= keepTurns) return i;
  }
  // Delegations normally contain a single user turn. Cut only at a complete
  // assistant/tool-cycle boundary, retaining the latest four cycles verbatim.
  const boundaries = [];
  for (let i = 2; i < messages.length; i++) {
    if (messages[i].role === "assistant") boundaries.push(i);
  }
  return boundaries.length > 4 ? boundaries[boundaries.length - 4] : -1;
}

// Render older messages as plain text for the summarize call.
function renderForSummary(messages, maxChars = MAX_SUMMARY_INPUT) {
  const lines = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "[image]").join(" ");
    if (m.tool_calls?.length) lines.push(`assistant → tools: ${m.tool_calls.map((t) => t.function?.name).join(", ")}`);
    if (text.trim()) lines.push(`${m.role}: ${text.slice(0, 2000)}`);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, Math.floor(maxChars / 4)) + "\n[intermediate history omitted]\n" + out.slice(-Math.floor(maxChars * 3 / 4));
  return out;
}

const SUMMARY_PROMPT = (transcript) =>
  `Summarize this earlier part of a conversation between a user and a coding agent so the agent can continue seamlessly. Cover: the state of the task, decisions made, files created or changed, and anything unresolved. Be concise and factual.\n\n${transcript}`;

// Returns { messages, note } — never throws. `summarize(prompt)` is an async
// model call; on failure we fall back to hard truncation with a notice.
async function compact(messages, summarize, { budget = DEFAULT_CONTEXT } = {}) {
  let cut = cutIndex(messages);
  if (cut <= 1) return { messages, note: null }; // nothing meaningful before the tail
  // Keep fewer complete cycles when routing to a small-context model.
  while (estimateTokens(messages.slice(cut)) > budget * 0.5) {
    const next = messages.findIndex((m, i) => i > cut && m.role === "assistant");
    if (next < 0) break;
    cut = next;
  }
  const before = estimateTokens(messages);
  const head = messages.slice(1, cut);
  const tail = messages.slice(cut);
  const task = messages.find((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith(SUMMARY_MARKER));
  const previousSummary = messages.find(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SUMMARY_MARKER));
  const priorTask = previousSummary?.content.includes(TASK_MARKER) ? previousSummary.content.slice(previousSummary.content.indexOf(TASK_MARKER) + TASK_MARKER.length) : "";
  const originalTask = priorTask || task?.content;
  const anchor = originalTask ? TASK_MARKER + originalTask.slice(0, 12000) : "";
  const summaryLimit = Math.max(256, Math.min(16000, Math.floor(budget * 0.8)));
  let summaryMsg;
  try {
    const summary = await summarize(SUMMARY_PROMPT(renderForSummary(head, Math.min(MAX_SUMMARY_INPUT, Math.floor(budget * 1.5)))));
    if (!summary || !summary.trim()) throw new Error("empty summary");
    summaryMsg = { role: "user", content: `${SUMMARY_MARKER}\n${summary.trim().slice(0, summaryLimit)}${anchor}` };
  } catch {
    summaryMsg = { role: "user", content: `${SUMMARY_MARKER}\n(Summary unavailable — older messages were truncated. Recheck files and completed work before repeating actions.)${anchor}` };
  }
  const out = [messages[0], summaryMsg, ...tail];
  const after = estimateTokens(out);
  return { messages: out, note: `Compacted ${head.length} older messages into a summary (~${Math.round(before / 1000)}k → ~${Math.round(after / 1000)}k tokens).` };
}

module.exports = { DEFAULT_CONTEXT, COMPACT_AT, SUMMARY_MARKER, estimateTokens, shouldCompact, cutIndex, compact };
