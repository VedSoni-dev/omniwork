"use strict";
// Cowork: run many agent sessions in parallel. Each session is an independent
// Agent with its own workspace, transcript, and status. The shared local
// gateway handles concurrent requests, so N agents can work at once.

const os = require("node:os");
const { Agent } = require("./agent");

let counter = 0;
function newId() { return "s" + (++counter) + "_" + Date.now().toString(36); }

class SessionManager {
  constructor({ gateway, mcp, emit }) {
    this.gateway = gateway;
    this.mcp = mcp;
    this.emit = emit; // (sessionId, type, payload) => void  (to renderer)
    this.sessions = new Map();
    this.activeId = null;
    this.model = "auto";
  }

  create({ workspace, title } = {}) {
    const id = newId();
    const ws = workspace || os.homedir();
    const sess = {
      id,
      title: title || "Session " + (this.sessions.size + 1),
      workspace: ws,
      status: "idle",     // idle | running | done | error
      transcript: [],     // recorded agent events for replay on switch
      createdAt: Date.now(),
      agent: null,
    };
    sess.agent = new Agent({
      baseUrl: this.gateway.baseUrl,
      apiKey: this.gateway.apiKey,
      model: this.model,
      workspace: ws,
      mcp: this.mcp,
      emit: (type, payload) => this.#onAgentEvent(id, type, payload),
    });
    this.sessions.set(id, sess);
    if (!this.activeId) this.activeId = id;
    this.#pushList();
    return this.serialize(sess);
  }

  #onAgentEvent(id, type, payload) {
    const sess = this.sessions.get(id);
    if (!sess) return;
    if (type === "error") sess.status = "error";
    else if (type === "done" || type === "aborted") sess.status = "done";
    // record for replay (skip pure stream noise to bound memory)
    sess.transcript.push({ type, ...payload });
    if (sess.transcript.length > 4000) sess.transcript.splice(0, 1000);
    this.emit(id, type, payload);
    if (type === "error" || type === "done" || type === "aborted") this.#pushList();
  }

  async send(id, text) {
    const sess = this.sessions.get(id);
    if (!sess) return;
    sess.status = "running";
    this.#pushList();
    // record the user line so switching back shows it
    sess.transcript.push({ type: "user", content: text });
    this.emit(id, "user", { content: text });
    try {
      await sess.agent.send(text);
    } catch (e) {
      sess.status = "error";
      this.emit(id, "error", { message: e.message });
      this.#pushList();
    }
  }

  stop(id) { const s = this.sessions.get(id); if (s && s.agent) s.agent.abort(); }

  remove(id) {
    const s = this.sessions.get(id);
    if (s && s.agent) s.agent.abort();
    this.sessions.delete(id);
    if (this.activeId === id) this.activeId = this.sessions.keys().next().value || null;
    this.#pushList();
  }

  setActive(id) { if (this.sessions.has(id)) this.activeId = id; }

  setWorkspace(id, ws) {
    const s = this.sessions.get(id);
    if (s) { s.workspace = ws; if (s.agent) s.agent.setWorkspace(ws); this.#pushList(); }
  }

  setModel(model) {
    this.model = model;
    for (const s of this.sessions.values()) if (s.agent) s.agent.model = model;
  }

  serialize(s) {
    return { id: s.id, title: s.title, workspace: s.workspace, status: s.status, createdAt: s.createdAt };
  }
  list() { return [...this.sessions.values()].map((s) => this.serialize(s)); }
  transcript(id) { const s = this.sessions.get(id); return s ? s.transcript : []; }

  #pushList() {
    this.emit(null, "sessions:list", { sessions: this.list(), activeId: this.activeId });
  }

  stopAll() { for (const s of this.sessions.values()) if (s.agent) s.agent.abort(); }
}

module.exports = { SessionManager };
