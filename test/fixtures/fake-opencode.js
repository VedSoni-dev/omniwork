#!/usr/bin/env node
"use strict";
// A stand-in for `opencode serve`: the slice of OpenCode's HTTP API that
// OmniWork's engine uses. Prints the same "listening on" line, streams the
// same events, honours the same permission handshake. Behaviour knobs come
// from the prompt text so tests can steer it:
//   "TOOL"       — run one fake tool (running → completed) before answering
//   "PERMISSION" — ask permission for a tool first (reply decides the answer)
//   "FAIL"       — finish with a session error
//   "SLOW"       — take 2s (for abort tests)
const http = require("node:http");
if (process.argv[2] !== "serve") { console.log("fake-opencode 0.0.0-test"); process.exit(0); }

const clients = new Set();
const sessions = new Map();
const pending = new Map(); // permissionID -> resolve(response)
let seq = 0;
const nid = (p) => `${p}${(++seq).toString(36).padStart(6, "0")}`;
const send = (ev) => {
  // Exercise both top-level and nested session IDs used by engine events.
  if (ev.properties?.part || ev.properties?.info) delete ev.properties.sessionID;
  const line = `data: ${JSON.stringify({ id: nid("evt_"), ...ev })}\n\n`; for (const c of clients) c.write(line);
};
const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const read = (req) => new Promise((r) => { let s = ""; req.on("data", (d) => { s += d; }); req.on("end", () => r(s ? JSON.parse(s) : {})); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROVIDERS = { all: [
  { id: "opencode", name: "OpenCode Zen", source: "api", env: ["OPENCODE_API_KEY"], options: {}, models: {
    "nemotron-3.5-lightning-free": { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", cost: { input: 0, output: 0 }, tool_call: true, limit: { context: 262144, output: 262144 } },
    "nemotron-3-ultra-free": { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", cost: { input: 0, output: 0 }, tool_call: true, limit: { context: 1000000, output: 128000 } },
    "big-pickle": { id: "big-pickle", name: "Big Pickle", cost: { input: 0, output: 0 }, tool_call: true, limit: { context: 200000, output: 32000 } },
    "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet", cost: { input: 3, output: 15 }, tool_call: true, limit: { context: 1000000, output: 64000 } },
  } },
  { id: "opencode-go", name: "OpenCode Go", source: "api", env: ["OPENCODE_API_KEY"], options: {}, models: {
    "ox-alpha-free": { id: "ox-alpha-free", name: "Ox Alpha Free", cost: { input: 0, output: 0 }, tool_call: true, limit: { context: 1000000, output: 131072 } },
  } },
  { id: "openai", models: { "connected-coder": { name: "Connected Coder", cost: { input: 1, output: 2 }, tool_call: true, limit: { context: 128000 } } } },
  { id: "not-connected", models: { "hidden": { cost: { input: 1, output: 2 }, tool_call: true } } },
], default: {}, connected: ["opencode", "openai"] };

const AUTH = process.env.OPENCODE_SERVER_PASSWORD ? "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64") : null;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  // Like the real server: with a password set, every request must carry it.
  if (AUTH && req.headers.authorization !== AUTH) return json(res, 401, { error: { type: "Unauthorized", message: "basic auth required" } });
  const dir = req.headers["x-opencode-directory"] ? decodeURIComponent(req.headers["x-opencode-directory"]) : null;
  if (u.pathname === "/global/health") return json(res, 200, { healthy: true, version: "0.0.0-test" });
  if (u.pathname === "/provider") return json(res, 200, PROVIDERS);
  if (u.pathname === "/event") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(":ok\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
  }
  if (req.method === "POST" && u.pathname === "/session") {
    const b = await read(req); const id = nid("ses_");
    sessions.set(id, { id, title: b.title, directory: dir, permission: b.permission || null, aborted: false });
    return json(res, 200, { id, title: b.title, directory: dir });
  }
  const m = /^\/session\/([^/]+)\/(message|abort|permissions\/([^/]+)|diff)$/.exec(u.pathname);
  if (m) {
    const s = sessions.get(m[1]); if (!s) return json(res, 404, { error: { type: "NotFound", message: "no session" } });
    if (m[2] === "abort") { s.aborted = true; return json(res, 200, true); }
    if (m[2] === "diff") return json(res, 200, []);
    if (m[2].startsWith("permissions/")) { const b = await read(req); const r = pending.get(m[3]); if (r) { r(b.response); pending.delete(m[3]); } return json(res, 200, true); }
    // message
    const b = await read(req);
    if (b.agent) {
      const configured = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}").agent?.[b.agent];
      if (!configured || configured.steps !== 24 || configured.permission?.skill === "allow" || configured.permission?.["*"] !== "deny" || !s.permission.some(p=>p.permission === "*" && p.action === "deny")) return json(res, 400, { error: { message: "Worker profile missing or unbounded" } });
    }
    const text = (b.parts || []).map((p) => p.text || "").join("\n");
    const messageID = nid("msg_");
    s.aborted = false;
    const partID = nid("prt_");
    if (/PERMISSION/.test(text)) {
      const pid = nid("per_");
      const response = await new Promise((resolve) => { pending.set(pid, resolve); send({ type: "permission.asked", properties: { id: pid, sessionID: s.id, permission: "bash", patterns: ["rm -rf build"], metadata: { command: "rm -rf build" }, always: [], tool: { messageID, callID: "call_perm" } } }); });
      if (response === "reject") {
        return json(res, 200, { info: { id: messageID, sessionID: s.id, role: "assistant", time: { created: Date.now(), completed: Date.now() }, modelID: b.model.modelID, providerID: b.model.providerID }, parts: [{ id: partID, sessionID: s.id, messageID, type: "text", text: "permission was rejected" }] });
      }
    }
    if (/TOOL/.test(text)) {
      send({ type: "message.updated", properties: { info: { id: nid("msg_"), sessionID: s.id, role: "assistant", tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 20, write: 0 } } } } });
      const callID = "call_1";
      const tid = nid("prt_");
      send({ type: "message.part.updated", properties: { sessionID: s.id, time: Date.now(), part: { id: tid, sessionID: s.id, messageID, type: "tool", callID, tool: "bash", state: { status: "pending", input: {}, time: { start: Date.now() } } } } });
      await sleep(10);
      send({ type: "message.part.updated", properties: { sessionID: s.id, time: Date.now(), part: { id: tid, sessionID: s.id, messageID, type: "tool", callID, tool: "bash", state: { status: "running", input: { command: "echo hi" }, title: "echo hi", time: { start: Date.now() } } } } });
      await sleep(30);
      send({ type: "message.part.updated", properties: { sessionID: s.id, time: Date.now(), part: { id: nid("prt_"), sessionID: s.id, messageID, type: "tool", callID, tool: "bash", state: { status: "completed", input: { command: "echo hi" }, output: "hi\n", title: "echo hi", metadata: {}, time: { start: Date.now(), end: Date.now() } } } } });
    }
    if (/SLOW/.test(text)) { for (let i = 0; i < 20 && !s.aborted; i++) await sleep(100); if (s.aborted) return json(res, 200, { info: { id: messageID, sessionID: s.id, role: "assistant", time: { created: Date.now() }, error: { name: "MessageAbortedError", data: { message: "aborted" } } }, parts: [] }); }
    if (/FAIL/.test(text)) {
      send({ type: "session.error", properties: { sessionID: s.id, error: { name: "APIError", data: { message: "upstream exploded" } } } });
      return json(res, 200, { info: { id: messageID, sessionID: s.id, role: "assistant", time: { created: Date.now() }, error: { name: "APIError", data: { message: "upstream exploded" } } }, parts: [] });
    }
    const answer = `READY from ${b.model.providerID}/${b.model.modelID} in ${s.directory || "(no dir)"}`;
    // reasoning first, on the same "text" field — a client must not show it as the reply
    const rid = nid("prt_");
    send({ type: "message.part.updated", properties: { sessionID: s.id, time: Date.now(), part: { id: rid, sessionID: s.id, messageID, type: "reasoning", text: "" } } });
    send({ type: "message.part.delta", properties: { sessionID: s.id, messageID, partID: rid, field: "text", delta: "thinking about it…" } });
    // the text part: first delta arrives BEFORE its part.updated, to exercise the hold
    send({ type: "message.part.delta", properties: { sessionID: s.id, messageID, partID, field: "text", delta: answer.slice(0, 5) } });
    send({ type: "message.part.updated", properties: { sessionID: s.id, time: Date.now(), part: { id: partID, sessionID: s.id, messageID, type: "text", text: answer.slice(0, 5) } } });
    await sleep(5);
    send({ type: "message.part.delta", properties: { sessionID: s.id, messageID, partID, field: "text", delta: answer.slice(5) } });
    send({ type: "session.idle", properties: { sessionID: s.id } });
    const tokens = { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
    send({ type: "message.part.updated", properties: { part: { id: nid("prt_"), sessionID: s.id, messageID, type: "step-finish", tokens } } });
    return json(res, 200, { info: { id: messageID, sessionID: s.id, role: "assistant", tokens, time: { created: Date.now(), completed: Date.now() }, modelID: b.model.modelID, providerID: b.model.providerID }, parts: [{ id: partID, sessionID: s.id, messageID, type: "text", text: answer }] });
  }
  json(res, 404, { error: { type: "NotFound", message: u.pathname } });
});
server.listen(0, "127.0.0.1", () => { console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`); });
