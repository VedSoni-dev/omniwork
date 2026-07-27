// Unit test: ProjectManager (find-or-create, legacy migration) + memory
// (save, inject, cap). No gateway needed — runs in milliseconds.
const fs = require("fs"), os = require("os"), path = require("path");
const { ProjectManager, projectId } = require("../electron/projects");
const { saveMemory, loadForPrompt, memoryFile } = require("../electron/memory");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-proj-"));
const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), "ow-ws1-"));
const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "ow-ws2-"));
let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

// find-or-create: same folder ⇒ same project, across instances
const pm = new ProjectManager(path.join(tmp, "projects"));
const a = pm.forWorkspace(ws1), b = pm.forWorkspace(ws1), c = pm.forWorkspace(ws2);
check("same folder → same project", a.id === b.id && a.id === projectId(ws1));
check("different folder → different project", a.id !== c.id);
check("registry persisted", new ProjectManager(path.join(tmp, "projects")).list().length === 2);

// legacy migration: sessions.json → projects + per-session assignment
const legacy = path.join(tmp, "sessions.json");
fs.writeFileSync(legacy, JSON.stringify({
  activeId: "s9",
  sessions: [{ id: "s9", title: "Old", workspace: ws1, transcript: [{ type: "user", content: "hi" }], messages: [] }],
}));
const migrated = pm.migrateLegacy(legacy);
check("migration returns sessions with projectId", migrated.length === 1 && migrated[0].projectId === a.id);
check("migration preserves activeId", pm.activeSessionId === "s9");
check("legacy file renamed to .bak", !fs.existsSync(legacy) && fs.existsSync(legacy + ".bak"));
check("migration is idempotent", pm.migrateLegacy(legacy).length === 0);

// memory: save → inject both scopes, newest wins the cap
const gDir = path.join(tmp, "memory"), pDir = pm.memoryDir(a.id);
saveMemory(gDir, "Tone", "User prefers concise answers.");
saveMemory(pDir, "Deploy", "Deploys go through scripts/setup.js.");
const inject = loadForPrompt(gDir, pDir);
check("inject contains both scopes", inject.includes("Global memory") && inject.includes("Project memory"));
check("inject contains saved facts", inject.includes("concise answers") && inject.includes("scripts/setup.js"));
check("memory file is plain markdown", fs.readFileSync(memoryFile(pDir), "utf8").startsWith("# Memory"));
for (let i = 0; i < 200; i++) saveMemory(pDir, "Fact " + i, "x".repeat(100));
check("inject respects 8KB cap", loadForPrompt(gDir, pDir).length <= 8000);

console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ PROJECTS + MEMORY TEST PASSED");
process.exit(fails ? 1 : 0);
