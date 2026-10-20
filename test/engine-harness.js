"use strict";
// Harness² harnesses as OpenCode engine configuration: reading and validating
// the component tree, staging it outside the workspace, and running it on an
// isolated engine (test/fixtures/fake-opencode.js stands in for `opencode serve`).
//
// Run: node test/engine-harness.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.OMNIWORK_OPENCODE_BIN = path.join(__dirname, "fixtures", "fake-opencode.js");
const harness = require("../electron/engine-harness");
const opencode = require("../electron/opencode-engine");

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log("✓", name); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-harness-"));
function tree(name, files) {
  const dir = path.join(root, name);
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); }
  return dir;
}
const skill = name => `---\nname: ${name}\ndescription: When a regression needs a minimal reproduction.\n---\nWrite the failing case first.\n`;
const full = tree("full", {
  "systemprompt.md": "SYSTEM_MARKER_1\nWhen a fix needs a reproduction, load the `repro` skill.\n",
  "guardrails.md": "GUARD_MARKER\n", "LongTermMEMORY.md": "", "tool_descriptions/tool_guidance.md": "TOOLS_MARKER\n",
  "skills/repro/SKILL.md": skill("repro"), "skills/repro/scripts/minimize.py": "print('min')\n",
  "sub_agents/reader/AGENT.md": "---\ndescription: Summarise a large file.\nmode: subagent\n---\nRead and summarise.\n",
  "scripts/check_totals.py": "print('ok')\n", "plugin/trim.ts": "export const Trim = async () => ({})\n",
  "scripts/README.md": "<!-- stub -->\n",
});

(async () => {
  await check("a full component tree reads with a stable, content-sensitive fingerprint", () => {
    const a = harness.read(full), b = harness.read(full);
    assert.equal(a.fingerprint, b.fingerprint);
    assert(!("scripts/README.md" in a.files), "README stubs are not components");
    const other = tree("other", { "systemprompt.md": "SYSTEM_MARKER_2\n" });
    assert.notEqual(harness.read(other).fingerprint, a.fingerprint);
  });
  await check("anything off the editable surface, or not a harness at all, is refused", () => {
    assert.throws(() => harness.read("relative/dir"), /absolute/);
    assert.throws(() => harness.read(path.join(root, "missing")), /existing/);
    assert.throws(() => harness.read(tree("empty", { "notes.md": "x" })), /off the editable surface: notes\.md/);
    assert.throws(() => harness.read(tree("bare", { "skills/README.md": "x" })), /Not a harness/);
    assert.throws(() => harness.read(tree("badname", { "systemprompt.md": "", "skills/Bad_Name/SKILL.md": skill("Bad_Name") })), /off the editable surface/);
    assert.throws(() => harness.read(tree("mismatch", { "systemprompt.md": "", "skills/repro/SKILL.md": skill("other") })), /frontmatter name must be "repro"/);
    assert.throws(() => harness.read(tree("loose", { "systemprompt.md": "", "skills/repro/SKILL.md": skill("repro"), "skills/repro/helper.py": "" })), /skills\/repro\/helper\.py/);
    const linked = tree("linked", { "systemprompt.md": "" });
    fs.symlinkSync("/etc/hosts", path.join(linked, "guardrails.md"));
    assert.throws(() => harness.read(linked), /symlink/);
    assert.throws(() => harness.read(tree("huge", { "systemprompt.md": "x".repeat(harness.LIMITS.alwaysOnChars + 1) })), /exceeds/);
  });
  let staged;
  await check("staging writes skills, subagents and plugins to the engine config dir and nothing to a workspace", () => {
    const h = harness.read(full);
    staged = harness.stage(h, path.join(root, "stage"));
    assert(fs.existsSync(path.join(staged.configDir, "skills/repro/SKILL.md")));
    assert(fs.existsSync(path.join(staged.configDir, "skills/repro/scripts/minimize.py")));
    assert(fs.existsSync(path.join(staged.configDir, "agent/reader.md")), "subagents use OpenCode's agent/<name>.md");
    assert(fs.existsSync(path.join(staged.configDir, "plugin/trim.ts")));
    assert(fs.existsSync(path.join(staged.dir, "scripts/check_totals.py")));
    assert.deepEqual([staged.skills, staged.subagents, staged.plugins], [true, true, true]);
    assert.equal(fs.statSync(path.join(staged.dir, "instructions.md")).mode & 0o777, 0o600);
    assert.equal(harness.stage(h, path.join(root, "stage")).dir, staged.dir, "a fingerprint stages once");
  });
  await check("always-on text keeps Harness²'s order and names where the helper scripts are", () => {
    const text = fs.readFileSync(staged.instructions, "utf8");
    const order = ["SYSTEM_MARKER_1", "GUARD_MARKER", "TOOLS_MARKER", "# HELPER SCRIPTS"].map(m => text.indexOf(m));
    assert(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), text);
    assert(text.includes(path.join(staged.dir, "scripts")) && text.includes("check_totals.py"));
    const quiet = harness.stage(harness.read(tree("quiet", { "systemprompt.md": "", "guardrails.md": "  \n" })), path.join(root, "stage"));
    assert.equal(quiet.instructions, null, "an empty harness adds no instructions");
    assert.equal(harness.engineConfig(quiet).instructions, undefined);
  });
  await check("a harness that changed after admission is refused", () => {
    const dir = tree("drift", { "systemprompt.md": "one\n" });
    const admitted = harness.read(dir);
    fs.writeFileSync(path.join(dir, "systemprompt.md"), "two\n");
    assert.throws(() => harness.prepare({ dir, fingerprint: admitted.fingerprint }, path.join(root, "stage")), /changed after the job was submitted/);
  });
  await check("the harness agent stays bounded and gains only the tools its components need", () => {
    const cfg = harness.agentConfig(staged, { steps: 30 });
    assert.equal(cfg.permission["*"], "deny"); assert.equal(cfg.steps, 30);
    assert.equal(cfg.permission.skill, "allow"); assert.equal(cfg.permission.task, "allow");
    const bare = harness.agentConfig({ skills: false, subagents: false });
    assert.equal(bare.permission.skill, undefined); assert.equal(bare.permission.task, undefined);
    assert(harness.permissions(staged, "plan").some(r => r.permission === "task" && r.action === "deny"));
    assert(harness.permissions(staged, "plan").filter(r => ["bash", "edit", "write"].includes(r.permission)).every(r => r.action === "deny"));
    const env = harness.engineEnv(staged);
    assert.equal(env.OPENCODE_CONFIG_DIR, staged.configDir);
    assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, "1"); assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
  });

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ow-harness-ws-"));
  const run = async (opts) => {
    const events = [];
    const agent = new opencode.OpenCodeAgent({ workspace, model: "opencode/big-pickle", emit: (type, p) => events.push({ type, ...p }), ...opts });
    await agent.send("HARNESS? then say READY");
    return { agent, events };
  };
  await check("a harness job runs its own isolated engine with the harness agent and instructions", async () => {
    const { agent, events } = await run({ engineProfile: "harness", harness: staged, maxSteps: 30 });
    assert(!events.some(e => e.type === "error"), JSON.stringify(events.filter(e => e.type === "error")));
    assert.notEqual(agent.engine, opencode.getEngine(), "never the shared engine");
    assert.match(agent.lastText, /agent=omniwork-harness instructions=SYSTEM_MARKER_1 skills=repro isolated=true/);
    assert.match(agent.lastText, /rules=\*:deny,.*skill:allow,task:allow/);
    const again = await run({ engineProfile: "harness", harness: staged, maxSteps: 30 });
    assert.equal(again.agent.engine, agent.engine, "one server per harness");
    const steps = await run({ engineProfile: "harness", harness: staged, maxSteps: 12 });
    assert.notEqual(steps.agent.engine, agent.engine, "the step limit is part of the server's config");
  });
  await check("profiles and harnesses cannot be mixed up", async () => {
    assert.throws(() => new opencode.OpenCodeAgent({ workspace, engineProfile: "harness", emit() {} }), /requires a staged harness/);
    assert.throws(() => new opencode.OpenCodeAgent({ workspace, engineProfile: "scoped", harness: staged, emit() {} }), /requires that profile/);
    const plain = await run({ engineProfile: "scoped" });
    assert.match(plain.agent.lastText, /agent=omniwork-scoped instructions= skills= isolated=false/, "existing profiles are unchanged");
  });
  console.log(`\n✅ ENGINE HARNESS TEST PASSED (${passed} checks)`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { opencode.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
