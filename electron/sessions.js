"use strict";
// Cowork: run many agent sessions in parallel. Each session is an independent
// Agent with its own workspace, transcript, and status. The shared local
// gateway handles concurrent requests, so N agents can work at once.
//
// Sessions persist to disk (transcript + agent context) and restore on restart.

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { Agent } = require("./agent");
const { saveMemory, memoryFile } = require("./memory");

let counter = 0;
function newId() { return "s" + (++counter) + "_" + Date.now().toString(36); }

// Replace base64 image parts with a light placeholder so persisted sessions stay small.
function stripImages(m) {
  if (!m || !Array.isArray(m.content)) return m;
  const content = m.content.map((c) => (c && c.type === "image_url" ? { type: "text", text: "[image]" } : c));
  return { ...m, content };
}

class SessionManager {
  constructor({ gateway, mcp, emit, projects, globalMemoryDir, skillsDir, browser, legacyPath }) {
    this.gateway = gateway;
    this.mcp = mcp;
    this.emit = emit; // (sessionId, type, payload) => void  (to renderer)
    this.projects = projects || null;         // ProjectManager
    this.globalMemoryDir = globalMemoryDir || null;
    this.skillsDir = skillsDir || null;
    this.browser = browser || null;
    this.legacyPath = legacyPath || null;     // old single-file store, migrated on restore
    this.sessions = new Map();
    this.activeId = null;
    this.model = "auto";
    this.approvalMode = "auto";        // "auto" | "ask"
    this.pendingApprovals = new Map();  // callId -> resolve
    this._saveTimer = null;
  }

  // ── persistence: one file per session, under its project ─────────
  #sessionFile(sess) {
    return path.join(this.projects.sessionsDir(sess.projectId), sess.id + ".json");
  }

  #snapshotOne(s) {
    return {
      id: s.id, title: s.title, workspace: s.workspace,
      status: s.status === "running" ? "done" : s.status,
      transcript: s.transcript.slice(-1500),
      messages: s.agent ? s.agent.messages.slice(-200).map(stripImages) : [],
    };
  }

  #writeNow() {
    for (const s of this.sessions.values()) {
      try { fs.writeFileSync(this.#sessionFile(s), JSON.stringify(this.#snapshotOne(s))); } catch {}
    }
    this.projects.activeSessionId = this.activeId;
    this.projects.save();
  }

  // Debounced by default. `immediate` is for quit, where a pending timer would
  // never get a chance to fire and the session would be lost.
  save({ immediate = false } = {}) {
    if (!this.projects) return;
    clearTimeout(this._saveTimer);
    if (immediate) { this.#writeNow(); return; }
    this._saveTimer = setTimeout(() => this.#writeNow(), 400);
  }

  #restoreOne(saved, projId) {
    const sess = {
      id: saved.id || newId(),
      title: saved.title || "Session",
      workspace: saved.workspace || os.homedir(),
      projectId: projId,
      status: saved.status === "running" ? "done" : (saved.status || "idle"),
      transcript: Array.isArray(saved.transcript) ? saved.transcript : [],
      createdAt: Date.now(),
      agent: null,
    };
    this.#buildAgent(sess);
    if (Array.isArray(saved.messages) && saved.messages.length) sess.agent.messages = saved.messages;
    this.sessions.set(sess.id, sess);
  }

  restore() {
    if (!this.projects) return 0;
    // Legacy single-file store → per-session files, once.
    for (const saved of this.projects.migrateLegacy(this.legacyPath)) {
      this.#restoreOne(saved, saved.projectId);
    }
    for (const proj of this.projects.list()) {
      const dir = this.projects.sessionsDir(proj.id);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const saved = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (!this.sessions.has(saved.id)) this.#restoreOne(saved, proj.id);
        } catch {}
      }
    }
    const act = this.projects.activeSessionId;
    this.activeId = act && this.sessions.has(act) ? act : (this.sessions.keys().next().value || null);
    if (this.sessions.size) { this.#pushList(); this.save(); }
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
      memory: this.projects ? { globalDir: this.globalMemoryDir, projectDir: this.projects.memoryDir(sess.projectId), knowledgeDir: this.projects.knowledgeDir(sess.projectId), instructionsFile: this.projects.instructionsFile(sess.projectId) } : null,
      skillsDir: this.skillsDir,
      browser: this.browser,
      approvalMode: this.approvalMode,
      approver: (callId, name, args, preview) =>
        new Promise((resolve) => {
          this.pendingApprovals.set(callId, resolve);
          // Remember what we're waiting on: switching sessions destroys the
          // renderer's approval card, and the turn hangs forever without it.
          sess.pendingApproval = { callId, name, args, preview };
          this.emit(id, "approval_request", { callId, name, args, preview });
        }),
      emit: (type, payload) => this.#onAgentEvent(id, type, payload),
    });
    if (this._ctxTokens) sess.agent.contextTokens = this._ctxTokens;
  }

  resolveApproval(callId, ok) {
    const r = this.pendingApprovals.get(callId);
    if (r) { this.pendingApprovals.delete(callId); r(!!ok); }
    for (const s of this.sessions.values()) {
      if (s.pendingApproval && s.pendingApproval.callId === callId) s.pendingApproval = null;
    }
  }

  setApprovalMode(mode) {
    this.approvalMode = ["auto", "ask", "edits", "plan"].includes(mode) ? mode : "auto";
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
    const ws = workspace || os.homedir();
    const sess = {
      id,
      title: title || "Session " + (this.sessions.size + 1),
      workspace: ws,
      projectId: this.projects ? this.projects.forWorkspace(ws).id : null,
      status: "idle",
      transcript: [],
      createdAt: Date.now(),
      agent: null,
    };
    if (this.projects) this.projects.touch(sess.projectId);
    this.#buildAgent(sess);
    this.sessions.set(id, sess);
    // A new session is what the user is now looking at — every broadcast must
    // agree, or the renderer navigates back to the stale active session.
    this.activeId = id;
    this.#pushList();
    this.save();
    return this.serialize(sess);
  }

  #onAgentEvent(id, type, payload) {
    const sess = this.sessions.get(id);
    if (!sess) return;
    if (type === "error") sess.status = "error";
    else if (type === "done" || type === "aborted") sess.status = "done";
    if (type !== "assistant_delta" && type !== "tool_stream" && type !== "thinking" && type !== "approval_request" && type !== "context" && type !== "stats") {
      sess.transcript.push({ type, ...payload });
      if (sess.transcript.length > 4000) sess.transcript.splice(0, 1000);
    }
    this.emit(id, type, payload);
    if (type === "error" || type === "done" || type === "aborted") { this.#pushList(); this.save(); }
    if (type === "done") {
      if (/^(Session \d+|Main)$/.test(sess.title)) this.#autoTitle(sess);
      this.#autoCapture(sess);
    }
  }

  // Name the session after its first completed turn ("Session 3" → "Fix login redirect").
  async #autoTitle(sess) {
    const first = sess.transcript.find((e) => e.type === "user");
    if (!first || !sess.agent) return;
    try {
      const t = await sess.agent.oneShot(
        `Name this coding session in 3-5 plain words based on the request below. Reply with only the name — no quotes, no punctuation.\n\nRequest: ${String(first.content).slice(0, 500)}`
      );
      const clean = String(t || "").trim().split("\n")[0].replace(/^["'#\s]+|["'.\s]+$/g, "").slice(0, 48);
      if (clean) { sess.title = clean; this.#pushList(); this.save(); }
    } catch {}
  }

  // After a substantive turn (3+ tool calls), ask once whether anything durable
  // was learned. Conservative by prompt; duplicates suppressed by title.
  async #autoCapture(sess) {
    if (!this.projects || !sess.agent) return;
    const idx = sess.transcript.map((e) => e.type).lastIndexOf("user");
    if (idx < 0) return;
    const turn = sess.transcript.slice(idx);
    if (turn.filter((e) => e.type === "tool_call").length < 3) return;
    const text = turn.map((e) => `${e.type}: ${String(e.content || e.name || "").slice(0, 300)}`).join("\n").slice(0, 6000);
    try {
      const r = await sess.agent.oneShot(
        `Below is the turn a coding agent just finished. If — and only if — it revealed something durable that future sessions need (a user preference, a project convention, a hard-won fix), reply exactly:\nSAVE|project or global|short title|one factual sentence\nOtherwise reply exactly: NONE\nMost turns are NONE.\n\n${text}`
      );
      const m = String(r || "").trim().match(/^SAVE\|(project|global)\|([^|\n]+)\|(.+)$/s);
      if (!m) return;
      const title = m[2].trim();
      const dir = m[1] === "global" ? this.globalMemoryDir : this.projects.memoryDir(sess.projectId);
      try { if (fs.readFileSync(memoryFile(dir), "utf8").toLowerCase().includes(title.toLowerCase())) return; } catch {}
      saveMemory(dir, title, m[3].trim().slice(0, 300));
      sess.transcript.push({ type: "system", content: `🧠 Remembered: ${title}` });
      this.emit(sess.id, "system", { content: `🧠 Remembered: ${title}` });
      this.save();
    } catch {}
  }

  // `label` is what the transcript shows (e.g. prompt + attachment names);
  // `text` is the full model input, which may embed attached file contents.
  async send(id, text, images, label) {
    const sess = this.sessions.get(id);
    if (!sess) return;
    sess.status = "running";
    this.#pushList();
    const shown = (label || text) + (images && images.length ? `  📎 ${images.length} image${images.length > 1 ? "s" : ""}` : "");
    sess.transcript.push({ type: "user", content: shown });
    this.emit(id, "user", { content: shown });
    try {
      await sess.agent.send(text, images);
    } catch (e) {
      sess.status = "error";
      this.emit(id, "error", { message: e.message });
      this.#pushList();
    }
  }

  stop(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    // A turn parked on an approval prompt isn't in the agent loop — deny it so
    // the abort flag is actually reached.
    if (s.pendingApproval) this.resolveApproval(s.pendingApproval.callId, false);
    if (s.agent) s.agent.abort();
  }

  // Manual /compact. No-op while the agent is mid-turn — the step loop compacts itself.
  async compactNow(id) {
    const s = this.sessions.get(id);
    if (!s || !s.agent || s.status === "running") return;
    const note = await s.agent.compactNow({ force: true });
    s.transcript.push({ type: "system", content: "⛁ " + note });
    this.emit(id, "system", { content: "⛁ " + note });
    this.save();
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (s && s.agent) s.agent.abort();
    if (s && this.projects) { try { fs.unlinkSync(this.#sessionFile(s)); } catch {} }
    this.sessions.delete(id);
    if (this.activeId === id) this.activeId = this.sessions.keys().next().value || null;
    this.#pushList();
    this.save();
  }

  setActive(id) {
    if (!this.sessions.has(id) || this.activeId === id) return; // no-change guard breaks broadcast loops
    this.activeId = id;
    this.#pushList();
    this.save();
  }

  rename(id, title) {
    const s = this.sessions.get(id);
    const t = String(title || "").trim().slice(0, 60);
    if (s && t) { s.title = t; this.#pushList(); this.save(); }
  }

  renameProject(projectId, name) {
    const p = this.projects && this.projects.byId(projectId);
    const n = String(name || "").trim().slice(0, 60);
    if (p && n) { p.name = n; this.projects.save(); this.#pushList(); }
  }

  // Changing folder can move the session to another project — its file and
  // memory follow it.
  setWorkspace(id, ws) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.projects) {
      const proj = this.projects.forWorkspace(ws);
      if (proj.id !== s.projectId) {
        try { fs.unlinkSync(this.#sessionFile(s)); } catch {}
        s.projectId = proj.id;
        if (s.agent) s.agent.memory = { globalDir: this.globalMemoryDir, projectDir: this.projects.memoryDir(proj.id), knowledgeDir: this.projects.knowledgeDir(proj.id), instructionsFile: this.projects.instructionsFile(proj.id) };
      }
      this.projects.touch(proj.id);
    }
    s.workspace = ws;
    if (s.agent) s.agent.setWorkspace(ws);
    this.#pushList();
    this.save();
  }

  setModel(model) {
    this.model = model;
    for (const s of this.sessions.values()) if (s.agent) s.agent.model = model;
    this.refreshContextLimit();
  }

  // Use the model's real context window (gateway exposes context_length);
  // agents keep their conservative default when it's unknown.
  async refreshContextLimit() {
    try {
      const res = await fetch(`${this.gateway.baseUrl}/models`, { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      const m = (data.data || []).find((x) => x.id === this.model);
      const ctx = m && (m.context_length || m.max_input_tokens);
      if (!ctx || ctx < 16_000) return;
      this._ctxTokens = ctx;
      for (const s of this.sessions.values()) if (s.agent) s.agent.contextTokens = ctx;
    } catch {}
  }

  serialize(s) {
    const proj = this.projects ? this.projects.byId(s.projectId) : null;
    return { id: s.id, title: s.title, workspace: s.workspace, status: s.status, createdAt: s.createdAt, projectId: s.projectId, projectName: proj ? proj.name : null };
  }
  list() { return [...this.sessions.values()].map((s) => this.serialize(s)); }
  transcript(id) { const s = this.sessions.get(id); return s ? s.transcript : []; }

  #pushList() { this.emit(null, "sessions:list", { sessions: this.list(), activeId: this.activeId }); }

  stopAll() { for (const s of this.sessions.values()) if (s.agent) s.agent.abort(); }
}

module.exports = { SessionManager };
