"use strict";
const crypto = require("node:crypto");
const number = v => Number.isFinite(v) && v >= 0 ? v : null;
const elapsed = row => row.startedAt != null && row.completedAt != null ? Math.max(0, row.completedAt - row.startedAt) : null;
const USAGE = ["input", "output", "reasoning"];
// Canonicalize arguments only in memory. A per-execution secret prevents saved
// fingerprints from becoming a dictionary of repository paths or shell commands.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
class ExecutionTrace {
  constructor({ limit = 1000 } = {}) {
    this.limit = limit; this.key = crypto.randomBytes(32); this.requests = new Map(); this.tools = new Map();
    this.discardedEvents = 0; this.verificationMs = 0; this.startedAt = Date.now();
  }
  row(map, key, prefix) {
    if (!key) return null;
    if (map.has(key)) return map.get(key);
    if (map.size >= this.limit) { this.discardedEvents++; return null; }
    const row = { id: prefix + (map.size + 1), startedAt: null, completedAt: null };
    map.set(key, row); return row;
  }
  event(type, p, turn) {
    if (!p?.id) return;
    if (type === "request") {
      const row = this.row(this.requests, `${turn}:${p.id}`, "r"); if (!row) return;
      row.turn = turn;
      if (typeof p.model === "string") row.model = p.model.slice(0, 300);
      for (const k of ["startedAt", "completedAt"]) if (number(p[k]) != null) row[k] = p[k];
      if (p.failed === true) row.failed = true;
      if (p.tokens) {
        row.usage = Object.fromEntries(USAGE.map(k => [k, number(p.tokens[k])]));
        row.usage.cacheRead = number(p.tokens.cache?.read);
        row.usage.cacheWrite = number(p.tokens.cache?.write);
        // OpenCode initializes in-flight messages with zero tokens. Those are
        // not a provider usage receipt, especially when generation is aborted.
        row.usageReported = Boolean(row.usageReported || p.usageReported || Object.values(row.usage).some(n => n > 0));
      }
    }
    if (type === "tool_call") {
      const row = this.row(this.tools, `${turn}:${p.id}`, "t"); if (!row) return;
      row.turn = turn; row.name = String(p.name || "unknown").slice(0, 100);
      row.startedAt ??= number(p.startedAt) ?? Date.now();
      row.request = p.requestId ? this.row(this.requests, `${turn}:${p.requestId}`, "r")?.id || null : null;
      row.fingerprint = crypto.createHmac("sha256", this.key).update(JSON.stringify([row.name, canonical(p.args || {})])).digest("hex").slice(0, 24);
    }
    if (type === "tool_result") {
      const row = this.row(this.tools, `${turn}:${p.id}`, "t"); if (!row) return;
      row.completedAt = number(p.completedAt) ?? Date.now(); row.ok = typeof p.ok === "boolean" ? p.ok : null;
      row.outputBytes = number(p.outputBytes) ?? Buffer.byteLength(String(p.result || ""));
      if (Number.isInteger(p.exitCode)) row.exitCode = p.exitCode;
    }
  }
  snapshot() {
    const requests = [...this.requests.values()].map(r => ({ ...r, elapsedMs: elapsed(r) }));
    const tools = [...this.tools.values()].map(r => ({ ...r, elapsedMs: elapsed(r) }));
    const reads = new Set(); let repeatedReads = 0;
    for (const t of tools) if (/^(read|read_file|glob|grep|list|list_dir)$/.test(t.name)) {
      if (reads.has(t.fingerprint)) repeatedReads++; else reads.add(t.fingerprint);
    }
    return { version: 1, requestCoverage: requests.length ? "observed" : "unavailable", coverage: "Observed engine assistant messages and tool events; provider retries, child sessions and full request payloads are not captured.",
      summary: { requestCoverage: requests.length ? "observed" : "unavailable", requests: requests.length, requestsWithUsage: requests.filter(r => r.usageReported && r.usage?.input != null && r.usage?.output != null).length,
        tools: tools.length, repeatedReads, toolOutputBytes: tools.reduce((n,t) => n + (t.outputBytes || 0), 0),
        requestsWithTiming: requests.filter(r => r.elapsedMs != null).length, toolsWithTiming: tools.filter(t => t.elapsedMs != null).length,
        cumulativeAssistantMs: requests.some(r => r.elapsedMs != null) ? requests.reduce((n,r) => n + (r.elapsedMs || 0), 0) : null,
        cumulativeToolMs: tools.some(t => t.elapsedMs != null) ? tools.reduce((n,t) => n + (t.elapsedMs || 0), 0) : null,
        verificationMs: this.verificationMs, executionMs: Date.now() - this.startedAt, discardedEvents: this.discardedEvents }, requests, tools };
  }
}
module.exports = { ExecutionTrace };
