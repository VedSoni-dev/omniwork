"use strict";
// Opt-in, content-bearing record of one execution: the prompts the agent was
// given, what it said, each tool call with its arguments, and what came back.
// Unlike the trace this holds repository content and prompts, so it is kept
// only when a caller asks (job `trajectory: true`) and written owner-only.
// Entries use OpenCode's `run --format json` part shape, so renderers written
// for OpenCode event streams (Harness²'s `render_events`) read it unchanged.
const FIELD = 64_000;

class ExecutionTrajectory {
  constructor({ limit = 4000 } = {}) {
    this.limit = limit; this.entries = []; this.tools = new Map();
    this.dropped = 0; this.truncated = 0; this.streamed = new Set();
  }
  clip(text) {
    const s = String(text ?? "");
    if (s.length <= FIELD) return s;
    this.truncated++;
    return s.slice(0, FIELD) + `…(+${s.length - FIELD} chars)`;
  }
  push(entry) {
    if (this.entries.length >= this.limit) { this.dropped++; return null; }
    this.entries.push(entry); return entry;
  }
  // Streamed text arrives in chunks; consecutive chunks of one kind form one part.
  append(kind, chunk, turn) {
    const last = this.entries[this.entries.length - 1];
    if (last?.type === kind && last.turn === turn && !last.closed) {
      if (last.part.text.length >= FIELD) { if (!last.clipped) { last.clipped = true; this.truncated++; } return; }
      last.part.text = (last.part.text + chunk).slice(0, FIELD);
    } else this.push({ type: kind, turn, part: { type: kind, text: this.clip(chunk) } });
  }
  prompt(text, turn) { this.push({ type: "user", turn, part: { type: "user", text: this.clip(text) } }); }
  event(type, p, turn) {
    if (!p) return;
    if (type === "assistant_delta" || type === "reasoning_delta") {
      if (!p.chunk) return;
      if (type === "assistant_delta") this.streamed.add(turn);
      this.append(type === "assistant_delta" ? "text" : "reasoning", p.chunk, turn);
    } else if (type === "assistant") {
      // Engines stream the reply and then send it whole; native agents only send it whole.
      if (p.content && !this.streamed.has(turn)) this.push({ type: "text", turn, closed: true, part: { type: "text", text: this.clip(p.content) } });
    } else if (type === "tool_call") {
      const json = JSON.stringify(p.args ?? {});
      const input = json.length <= FIELD ? p.args ?? {} : { truncated: this.clip(json) };
      const entry = this.push({ type: "tool", turn, part: { type: "tool", tool: String(p.name || "tool"), callID: p.id, state: { status: "running", input } } });
      if (entry) this.tools.set(`${turn}:${p.id}`, entry);
    } else if (type === "tool_result") {
      const entry = this.tools.get(`${turn}:${p.id}`) || this.push({ type: "tool", turn, part: { type: "tool", tool: String(p.name || "tool"), callID: p.id, state: {} } });
      if (!entry) return;
      const state = entry.part.state;
      state.status = p.ok === false ? "error" : "completed";
      state[p.ok === false ? "error" : "output"] = this.clip(p.result);
      if (Number.isInteger(p.exitCode)) state.exitCode = p.exitCode;
    } else if (type === "error" && p.message) this.push({ type: "error", turn, error: { message: this.clip(p.message) } });
    else if (type === "system" && p.content) this.push({ type: "system", turn, part: { type: "system", text: this.clip(p.content) } });
  }
  snapshot() {
    const entries = this.entries.map(({ closed, clipped, ...e }) => e);
    return { version: 1, summary: { entries: entries.length, tools: entries.filter(e => e.type === "tool").length, dropped: this.dropped, truncated: this.truncated }, entries };
  }
}
module.exports = { ExecutionTrajectory, FIELD };
