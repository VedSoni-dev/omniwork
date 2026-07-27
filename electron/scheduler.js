"use strict";
// Scheduled tasks, like Claude's project "Scheduled" section: a recurring
// prompt per project that fires into a fresh session on an interval.
// Persisted per project (schedule.json); a one-minute tick checks due tasks.
// lastRun survives restarts, so a relaunch never replays missed history —
// a task fires when (now - lastRun) >= its interval.

const fs = require("node:fs");
const path = require("node:path");

const EVERY = { hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
const TICK_MS = 60_000;

class Scheduler {
  constructor({ projects, sessions }) {
    this.projects = projects;
    this.sessions = sessions;
    this.timer = null;
  }

  #file(pid) { return path.join(this.projects.rootDir, pid, "schedule.json"); }

  list(pid) {
    try { return JSON.parse(fs.readFileSync(this.#file(pid), "utf8")); } catch { return []; }
  }

  #save(pid, tasks) {
    fs.mkdirSync(path.dirname(this.#file(pid)), { recursive: true });
    fs.writeFileSync(this.#file(pid), JSON.stringify(tasks, null, 2));
  }

  add(pid, { prompt, every }) {
    const p = String(prompt || "").trim();
    if (!p) throw new Error("a prompt is required");
    if (!EVERY[every]) throw new Error("every must be hour, day, or week");
    const tasks = this.list(pid);
    const task = { id: "t" + Date.now().toString(36), prompt: p.slice(0, 2000), every, lastRun: Date.now() };
    tasks.push(task);
    this.#save(pid, tasks);
    return task;
  }

  remove(pid, taskId) {
    this.#save(pid, this.list(pid).filter((t) => t.id !== taskId));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch {} }, TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  // Exposed for tests: fire everything due as of `now`.
  tick(now = Date.now()) {
    const fired = [];
    for (const proj of this.projects.list()) {
      const tasks = this.list(proj.id);
      let dirty = false;
      for (const t of tasks) {
        if (now - (t.lastRun || 0) < (EVERY[t.every] || Infinity)) continue;
        t.lastRun = now;
        dirty = true;
        fired.push({ project: proj, task: t });
      }
      if (dirty) this.#save(proj.id, tasks);
    }
    for (const { project, task } of fired) this.#fire(project, task);
    return fired.length;
  }

  #fire(project, task) {
    try {
      const s = this.sessions.create({ workspace: project.path, title: "⏰ " + task.prompt.slice(0, 40) });
      this.sessions.send(s.id, task.prompt);
    } catch {}
  }
}

module.exports = { Scheduler, EVERY };
