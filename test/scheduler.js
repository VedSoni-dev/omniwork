// Unit test: scheduler fire logic (no timers — tick() is called directly with
// synthetic clocks) plus project instructions/description round-trips.
const fs = require("fs"), os = require("os"), path = require("path");
const { ProjectManager } = require("../electron/projects");
const { Scheduler } = require("../electron/scheduler");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sched-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sched-ws-"));
const pm = new ProjectManager(path.join(tmp, "projects"));
const proj = pm.forWorkspace(ws);

// fake session manager records what fires
const fired = [];
const fakeSessions = {
  create: ({ workspace, title }) => { const s = { id: "s" + fired.length, workspace, title }; fired.push({ kind: "create", s }); return s; },
  send: (id, prompt) => fired.push({ kind: "send", id, prompt }),
};
const sched = new Scheduler({ projects: pm, sessions: fakeSessions });

const task = sched.add(proj.id, { prompt: "Summarize today's commits", every: "hour" });
check("add returns a task", !!task.id && task.every === "hour");
check("rejects empty prompt", (() => { try { sched.add(proj.id, { prompt: " ", every: "day" }); return false; } catch { return true; } })());
check("rejects bad interval", (() => { try { sched.add(proj.id, { prompt: "x", every: "minute" }); return false; } catch { return true; } })());

const t0 = task.lastRun;
check("not due immediately", sched.tick(t0 + 60_000) === 0);
check("fires after the interval", sched.tick(t0 + 3_700_000) === 1);
check("fired into a session in the project folder", fired[0].s.workspace === ws && fired[1].prompt === "Summarize today's commits");
check("does not refire until next interval", sched.tick(t0 + 3_800_000) === 0);
check("lastRun persisted", sched.list(proj.id)[0].lastRun === t0 + 3_700_000);

sched.remove(proj.id, task.id);
check("remove deletes the task", sched.list(proj.id).length === 0);

// project instructions + description
pm.writeInstructions(proj.id, "Always use TypeScript strict mode.");
check("instructions round-trip", pm.readInstructions(proj.id).includes("strict mode"));
pm.describe(proj.id, { description: "Test project" });
check("description persists across reload", new ProjectManager(path.join(tmp, "projects")).byId(proj.id).description === "Test project");

console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ SCHEDULER + INSTRUCTIONS TEST PASSED");
process.exit(fails ? 1 : 0);
