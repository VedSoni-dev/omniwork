"use strict";
const crypto = require("node:crypto");

// Retain raw output for the life of the task. The model sees an explicit page,
// never a lossy rewrite of source or evidence. References are session-local.
class ToolOutputStore {
  constructor() { this.entries = new Map(); this.bytes = 0; }
  capture(text, limit = 12000) {
    text = String(text);
    if (text.length <= limit) return text;
    const id = crypto.randomUUID();
    this.entries.set(id, text); this.bytes += text.length;
    while (this.bytes > 8_000_000 && this.entries.size > 1) {
      const first = this.entries.keys().next().value;
      this.bytes -= this.entries.get(first).length; this.entries.delete(first);
    }
    const tail = Math.min(2000, Math.floor(limit / 4));
    return `${text.slice(0, limit - tail)}\n[Output paged: ${text.length} characters. read_output id=${id}, offset=0, limit=${limit} retrieves the original; use subsequent offsets for more.]\n${text.slice(-tail)}`;
  }
  read(id, offset = 0, limit = 12000) {
    const text = this.entries.get(id);
    if (text == null) return "Error in read_output: output expired or belongs to another task; rerun the tool.";
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const count = Math.min(24000, Math.max(1, Math.floor(Number(limit) || 12000)));
    return `${text.slice(start, start + count)}\n[characters ${start}-${Math.min(start + count, text.length)} of ${text.length}${start + count < text.length ? `; next offset=${start + count}` : "; end"}]`;
  }
}
const OUTPUT_TOOL = { type: "function", function: { name: "read_output", description: "Retrieve original tool output by its session-local id and character offset when a result was paged. No compression or omitted middle within the requested page.", parameters: { type: "object", properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 24000 } }, required: ["id"] } } };
module.exports = { ToolOutputStore, OUTPUT_TOOL };
