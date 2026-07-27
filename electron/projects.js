"use strict";
// Projects: a workspace folder plus everything that belongs to it — its
// sessions (one file each) and its memory. Projects are born from use: the
// first session in a folder creates its project. Same folder ⇒ same project.
//
//   <root>/index.json                 { activeSessionId, projects: [...] }
//   <root>/<id>/sessions/<sid>.json   one file per session
//   <root>/<id>/memory/MEMORY.md      project memory (see memory.js)

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const projectId = (ws) => crypto.createHash("sha1").update(path.resolve(ws)).digest("hex").slice(0, 8);

class ProjectManager {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.projects = new Map(); // id -> { id, name, path, lastOpened }
    this.activeSessionId = null;
    fs.mkdirSync(rootDir, { recursive: true });
    this.#load();
  }

  #indexPath() { return path.join(this.rootDir, "index.json"); }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.#indexPath(), "utf8"));
      for (const p of data.projects || []) this.projects.set(p.id, p);
      this.activeSessionId = data.activeSessionId || null;
    } catch {}
  }

  save() {
    try {
      fs.writeFileSync(this.#indexPath(), JSON.stringify({
        activeSessionId: this.activeSessionId,
        projects: [...this.projects.values()],
      }, null, 2));
    } catch {}
  }

  // Find-or-create the project owning a workspace folder.
  forWorkspace(ws) {
    const id = projectId(ws);
    let p = this.projects.get(id);
    if (!p) {
      p = { id, name: path.basename(ws) || ws, path: path.resolve(ws), lastOpened: Date.now() };
      this.projects.set(id, p);
      this.save();
    }
    return p;
  }

  byId(id) { return this.projects.get(id) || null; }

  describe(id, { name, description } = {}) {
    const p = this.projects.get(id);
    if (!p) return null;
    if (name && String(name).trim()) p.name = String(name).trim().slice(0, 60);
    if (description !== undefined) p.description = String(description).slice(0, 500);
    this.save();
    return p;
  }

  // Per-project instructions (like Claude's project instructions): injected
  // into every session's system prompt, editable from the project page.
  instructionsFile(id) {
    fs.mkdirSync(path.join(this.rootDir, id), { recursive: true });
    return path.join(this.rootDir, id, "INSTRUCTIONS.md");
  }

  readInstructions(id) {
    try { return fs.readFileSync(this.instructionsFile(id), "utf8"); } catch { return ""; }
  }

  writeInstructions(id, content) {
    fs.writeFileSync(this.instructionsFile(id), String(content ?? ""), "utf8");
  }
  list() { return [...this.projects.values()].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0)); }

  touch(id) { const p = this.projects.get(id); if (p) { p.lastOpened = Date.now(); this.save(); } }

  sessionsDir(id) {
    const d = path.join(this.rootDir, id, "sessions");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  memoryDir(id) {
    const d = path.join(this.rootDir, id, "memory");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  // Project knowledge: files the user drops in for the agent to consult
  // (like Claude's project knowledge). Read on demand via read_knowledge.
  knowledgeDir(id) {
    const d = path.join(this.rootDir, id, "knowledge");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  // One-time migration from the legacy single-file store (sessions.json).
  // Returns the saved sessions it found, already assigned to projects.
  migrateLegacy(legacyPath) {
    if (!legacyPath || !fs.existsSync(legacyPath)) return [];
    let data;
    try { data = JSON.parse(fs.readFileSync(legacyPath, "utf8")); } catch { return []; }
    const out = [];
    for (const saved of (data && data.sessions) || []) {
      if (!saved.workspace) continue;
      const p = this.forWorkspace(saved.workspace);
      out.push({ ...saved, projectId: p.id });
    }
    this.activeSessionId = (data && data.activeId) || this.activeSessionId;
    this.save();
    try { fs.renameSync(legacyPath, legacyPath + ".bak"); } catch {}
    return out;
  }
}

module.exports = { ProjectManager, projectId };
