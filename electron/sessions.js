"use strict";
// Cowork: run many agent sessions in parallel. Each session is an independent
// Agent with its own workspace, transcript, and status. The shared local
// gateway handles concurrent requests, so N agents can work at once.
//
// Sessions persist to disk (transcript + agent context) and restore on restart.

const os = require("node:os");
const fs = require("node:fs");
const { Agent } = require("./agent");

let counter = 0;
function newId() { return "s" + (++counter) + "_" + Date.now().toString(36); }

// Replace base64 image parts with a light placeholder so persisted sessions stay small.
function stripImages(m) {
  if (!m || !Array.isArray(m.content)) return m;
  const content = m.content.map((c) => (c && c.type === "image_url" ? { type: "text", text: "[image]" } : c));
  return { ...m, content };
}

class SessionManager {
  constructor({ gateway, mcp, emit, persistPath }) {
    this.gateway = gateway;
    this.mcp = mcp;
    this.emit = emit; // (sessionId, type, payload) => void  (to renderer)
    this.persistPath = persistPath || null;
    this.sessions = new Map();
    this.activeId = null;
    this.model = "auto";
    this.approvalMode = "auto";        // "auto" | "ask"
    this.pendingApprovals = new Map();  // callId -> resolve
    this._saveTimer = null;
  }

  // ── persistence ──────────────────────────────────────────────────
  #snapshot() {
    return {
      activeId: this.activeId,
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.id, title: s.title, workspace: s.workspace,
        status: s.status === "running" ? "done" : s.status,
        transcript: s.transcript.slice(-1500),
        messages: s.agent ? s.agent.messages.slice(-200).map(stripImages) : [],
      })),
    };
  }

  #writeNow() {
    try { fs.writeFileSync(this.persistPath, JSON.stringify(this.#snapshot())); } catch {}
  }

  // Debounced by default. `immediate` is for quit, where a pending timer would
  // never get a chance to fire and the session would be lost.
  save({ immediate = false } = {}) {
    if (!this.persistPath) return;
    clearTimeout(this._saveTimer);
    if (immediate) { this.#writeNow(); return; }
    this._saveTimer = setTimeout(() => this.#writeNow(), 400);
  }

  restore() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return 0;
    let data;
    try { data = JSON.parse(fs.readFileSync(this.persistPath, "utf8")); } catch { return 0; }
    const list = (data && data.sessions) || [];
    for (const saved of list) {
      const sess = {
        id: saved.id || newId(),
        title: saved.title || "Session",
        workspace: saved.workspace || os.homedir(),
        status: saved.status === "running" ? "done" : (saved.status || "idle"),
        transcript: Array.isArray(saved.transcript) ? saved.transcript : [],
        createdAt: Date.now(),
        agent: null,
      };
      this.#buildAgent(sess);
      if (Array.isArray(saved.messages) && saved.messages.length) sess.agent.messages = saved.messages;
      this.sessions.set(sess.id, sess);
    }
    if (data.activeId && this.sessions.has(data.activeId)) this.activeId = data.activeId;
    else this.activeId = this.sessions.keys().next().value || null;
    if (this.sessions.size) this.#pushList();
    return this.sessions.size;
  }

  // ── agent wiring ─────────────────────────────────────────────────
  #buildAgent(sess) {
    const id = sess.id;
    sess.agent = new Agent({
      baseUrl: this.gateway.baseUrl,
      apiKey: this.gateway.apiKey,
      model: this.model,
      workspace: sess.workspace,
      mcp: this.mcp,
      approvalMode: this.approvalMode,
      approver: (callId, name, args, preview) =>
        new Promise((resolve) => {
          this.pendingApprovals.set(callId, resolve);
          this.emit(id, "approval_request", { callId, name, args, preview });
        }),
      emit: (type, payload) => this.#onAgentEvent(id, type, payload),
    });
  }

  resolveApproval(callId, ok) {
    const r = this.pendingApprovals.get(callId);
    if (r) { this.pendingApprovals.delete(callId); r(!!ok); }
  }

  setApprovalMode(mode) {
    this.approvalMode = mode === "ask" ? "ask" : "auto";
    for (const s of this.sessions.values()) if (s.agent) s.agent.approvalMode = this.approvalMode;
    return this.approvalMode;
  }

  undo(id) {
    const s = this.sessions.get(id);
    if (!s || !s.agent) return;
    const msg = s.agent.undo();
    s.transcript.push({ type: "system", content: msg });
    this.emit(id, "system", { content: msg });
    this.#pushList();
    this.save();
  }

  create({ workspace, title } = {}) {
    const id = newId();
    const sess = {
      id,
      title: title || "Session " + (this.sessions.size + 1),
      workspace: workspace || os.homedir(),
      status: "idle",
      transcript: [],
      createdAt: Date.now(),
      agent: null,
    };
    this.#buildAgent(sess);
    this.sessions.set(id, sess);
    if (!this.activeId) this.activeId = id;
    this.#pushList();
    this.save();
    return this.serialize(sess);
  }

  #onAgentEvent(id, type, payload) {
    const sess = this.sessions.get(id);
    if (!sess) return;
    if (type === "error") sess.status = "error";
    else if (type === "done" || type === "aborted") sess.status = "done";
    if (type !== "assistant_delta" && type !== "tool_stream" && type !== "thinking" && type !== "approval_request") {
      sess.transcript.push({ type, ...payload });
      if (sess.transcript.length > 4000) sess.transcript.splice(0, 1000);
    }
    this.emit(id, type, payload);
    if (type === "error" || type === "done" || type === "aborted") { this.#pushList(); this.save(); }
  }

  async send(id, text, images) {
    const sess = this.sessions.get(id);
    if (!sess) return;
    sess.status = "running";
    this.#pushList();
    const label = text + (images && images.length ? `  📎 ${images.length} image${images.length > 1 ? "s" : ""}` : "");
    sess.transcript.push({ type: "user", content: label });
    this.emit(id, "user", { content: label });
    try {
      await sess.agent.send(text, images);
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
    this.save();
  }

  setActive(id) { if (this.sessions.has(id)) { this.activeId = id; this.save(); } }

  setWorkspace(id, ws) {
    const s = this.sessions.get(id);
    if (s) { s.workspace = ws; if (s.agent) s.agent.setWorkspace(ws); this.#pushList(); this.save(); }
  }

  setModel(model) {
    this.model = model;
    for (const s of this.sessions.values()) if (s.agent) s.agent.model = model;
  }

  serialize(s) { return { id: s.id, title: s.title, workspace: s.workspace, status: s.status, createdAt: s.createdAt }; }
  list() { return [...this.sessions.values()].map((s) => this.serialize(s)); }
  transcript(id) { const s = this.sessions.get(id); return s ? s.transcript : []; }

  #pushList() { this.emit(null, "sessions:list", { sessions: this.list(), activeId: this.activeId }); }

  stopAll() { for (const s of this.sessions.values()) if (s.agent) s.agent.abort(); }
}

module.exports = { SessionManager };
