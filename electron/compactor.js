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
  return -1; // fewer than keepTurns turns — nothing to cut
}

// Render older messages as plain text for the summarize call.
function renderForSummary(messages) {
  const lines = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "[image]").join(" ");
    if (m.tool_calls?.length) lines.push(`assistant → tools: ${m.tool_calls.map((t) => t.function?.name).join(", ")}`);
    if (text.trim()) lines.push(`${m.role}: ${text.slice(0, 2000)}`);
  }
  let out = lines.join("\n");
  if (out.length > MAX_SUMMARY_INPUT) out = out.slice(-MAX_SUMMARY_INPUT);
  return out;
}

const SUMMARY_PROMPT = (transcript) =>
  `Summarize this earlier part of a conversation between a user and a coding agent so the agent can continue seamlessly. Cover: the state of the task, decisions made, files created or changed, and anything unresolved. Be concise and factual.\n\n${transcript}`;

// Returns { messages, note } — never throws. `summarize(prompt)` is an async
// model call; on failure we fall back to hard truncation with a notice.
async function compact(messages, summarize) {
  const cut = cutIndex(messages);
  if (cut <= 1) return { messages, note: null }; // nothing meaningful before the tail
  const before = estimateTokens(messages);
  const head = messages.slice(1, cut);
  const tail = messages.slice(cut);
  let summaryMsg;
  try {
    const summary = await summarize(SUMMARY_PROMPT(renderForSummary(head)));
    if (!summary || !summary.trim()) throw new Error("empty summary");
    summaryMsg = { role: "user", content: `${SUMMARY_MARKER}\n${summary.trim()}` };
  } catch {
    summaryMsg = { role: "user", content: `${SUMMARY_MARKER}\n(Summary unavailable — older messages were truncated.)` };
  }
  const out = [messages[0], summaryMsg, ...tail];
  const after = estimateTokens(out);
  return { messages: out, note: `Compacted ${head.length} older messages into a summary (~${Math.round(before / 1000)}k → ~${Math.round(after / 1000)}k tokens).` };
}

module.exports = { DEFAULT_CONTEXT, COMPACT_AT, SUMMARY_MARKER, estimateTokens, shouldCompact, cutIndex, compact };
