// Unit test: ProjectManager (find-or-create, legacy migration) + memory
// (save, inject, cap). No gateway needed — runs in milliseconds.
const fs = require("fs"), os = require("os"), path = require("path");
const { ProjectManager, projectId } = require("../electron/projects");
const { saveMemory, loadForPrompt, memoryFile, listKnowledge, knowledgeSection, readKnowledge } = require("../electron/memory");

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

// project knowledge: list → prompt section → read, with guardrails
const kDir = pm.knowledgeDir(a.id);
fs.writeFileSync(path.join(kDir, "spec.md"), "# The Spec\nBuild the thing.");
fs.writeFileSync(path.join(kDir, "data.bin"), Buffer.from([0, 1, 2, 255]));
fs.writeFileSync(path.join(kDir, "big.txt"), "y".repeat(30_000));
check("knowledge listed with sizes", listKnowledge(kDir).some((f) => f.name === "spec.md" && f.size > 0));
check("prompt section names the files", knowledgeSection(kDir).includes("spec.md"));
check("empty knowledge → empty section", knowledgeSection(pm.knowledgeDir(c.id)) === "");
check("read returns contents", readKnowledge(kDir, "spec.md").includes("Build the thing"));
check("read refuses binary", readKnowledge(kDir, "data.bin").includes("binary"));
check("read truncates big files", readKnowledge(kDir, "big.txt").includes("truncated"));
check("read blocks path escapes", readKnowledge(kDir, "../memory/MEMORY.md").includes("No knowledge file"));
check("read unknown → helpful list", readKnowledge(kDir, "nope.txt").includes("spec.md"));

console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ PROJECTS + MEMORY TEST PASSED");
process.exit(fails ? 1 : 0);
