"use strict";
// A Harness² harness (github.com/google-research/harness2) as an OpenCode
// engine configuration. A harness is a directory of up to eight components:
//
//   systemprompt.md, guardrails.md, LongTermMEMORY.md,
//   tool_descriptions/tool_guidance.md        always-on text
//   skills/<name>/SKILL.md (+ scripts/)        on-demand workflows
//   sub_agents/<name>/AGENT.md                 delegated subagents
//   scripts/<name>.py                          deterministic helpers
//   plugin/<name>.ts                           in-loop OpenCode plugins
//
// Harness² installs the always-on text on top of OpenCode's stock provider
// prompt (its AGENTS.md "append" mode). This does the same through OpenCode's
// `instructions` config so nothing lands in the workspace: a staged file in the
// worktree would show up in the job's patch. Each harness runs on its own
// engine process, isolated from the user's global OpenCode and Claude Code
// configuration (measured: ~/.claude/skills otherwise joins the skill catalog),
// so the harness is the only thing that differs between two runs.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const workerProfile = require("./engine-profile");

const AGENT = "omniwork-harness";
const ALWAYS_ON = ["systemprompt.md", "guardrails.md", "LongTermMEMORY.md", "tool_descriptions/tool_guidance.md"];
// The editable surface, as Harness²'s OPENCODE_SURFACE defines it (core/tree.py).
const NAME = "[a-z0-9][a-z0-9_\\-]*";
const SKILL = new RegExp(`^skills/(${NAME})/SKILL\\.md$`);
const SUBAGENT = new RegExp(`^sub_agents/(${NAME})/AGENT\\.md$`);
const SURFACE = [SKILL, SUBAGENT, new RegExp(`^skills/${NAME}/scripts/[A-Za-z0-9_.\\-]+$`), /^scripts\/[a-z0-9_][a-z0-9_]*\.py$/, new RegExp(`^plugin/${NAME}\\.ts$`)];
const STUBS = new Set(["scripts/README.md", "sub_agents/README.md", "plugin/README.md", "skills/README.md"]);
const LIMITS = { files: 200, fileBytes: 256 * 1024, alwaysOnChars: 64_000 };

function frontmatter(body, key) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  const line = m && new RegExp(`^${key}:\\s*(.+)$`, "m").exec(m[1]);
  return line ? line[1].trim().replace(/^["']|["']$/g, "") : null;
}

// Read and validate a harness directory. Anything off the surface is refused
// rather than skipped: a file the engine would never see means the caller's
// tree and the run disagree.
function read(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error("harness_dir must be an absolute directory");
  let root;
  try { root = fs.realpathSync(dir); } catch { throw new Error("harness_dir must be an existing absolute directory"); }
  if (!fs.statSync(root).isDirectory()) throw new Error("harness_dir must be an existing absolute directory");
  const files = {}, rejected = [];
  let count = 0;
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name, p = path.join(abs, e.name);
      if (e.name === "__pycache__" || e.name === ".DS_Store") continue;
      if (e.isSymbolicLink()) { rejected.push(`${r} (symlink)`); continue; }
      if (e.isDirectory()) { walk(p, r); continue; }
      if (STUBS.has(r)) continue;
      if (!e.isFile() || (!ALWAYS_ON.includes(r) && !SURFACE.some(rx => rx.test(r)))) { rejected.push(r); continue; }
      if (++count > LIMITS.files) throw new Error(`A harness holds at most ${LIMITS.files} files`);
      if (fs.statSync(p).size > LIMITS.fileBytes) throw new Error(`Harness file is larger than ${LIMITS.fileBytes} bytes: ${r}`);
      files[r] = fs.readFileSync(p, "utf8");
    }
  };
  walk(root, "");
  if (rejected.length) throw new Error(`Harness files are off the editable surface: ${rejected.slice(0, 8).join(", ")}`);
  if (!ALWAYS_ON.some(f => f in files)) throw new Error(`Not a harness: none of ${ALWAYS_ON.join(", ")} exists`);
  if (ALWAYS_ON.reduce((n, f) => n + (files[f] || "").length, 0) > LIMITS.alwaysOnChars) throw new Error(`Always-on harness text exceeds ${LIMITS.alwaysOnChars} characters`);
  for (const [rel, body] of Object.entries(files)) {
    const m = SKILL.exec(rel);
    if (m && frontmatter(body, "name") !== m[1]) throw new Error(`${rel}: frontmatter name must be "${m[1]}", or OpenCode drops the skill`);
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))).digest("hex");
  return { dir: root, files, fingerprint };
}

// The always-on text in Harness²'s order, plus where the helper scripts live:
// they cannot sit in the worktree, so the agent is told their real location.
function instructions(harness, scriptsDir) {
  const parts = ALWAYS_ON.map(f => (harness.files[f] || "").trim()).filter(Boolean);
  const scripts = Object.keys(harness.files).filter(r => r.startsWith("scripts/")).map(r => path.posix.basename(r));
  if (scripts.length) parts.push(`# HELPER SCRIPTS\nThe harness's scripts/ directory is at \`${scriptsDir}\`: ${scripts.join(", ")}\nRun one with \`python3 ${scriptsDir}/<name>.py\`.`);
  return parts.join("\n\n---\n\n");
}

function describe(harness, dir) {
  const has = prefix => Object.keys(harness.files).some(r => r.startsWith(prefix));
  const text = fs.readFileSync(path.join(dir, "instructions.md"), "utf8");
  return { fingerprint: harness.fingerprint, dir, configDir: path.join(dir, "config"), xdgConfigHome: path.join(dir, "xdg-config"),
    instructions: text.trim() ? path.join(dir, "instructions.md") : null, skills: has("skills/"), subagents: has("sub_agents/"), plugins: has("plugin/") };
}

// Materialise once per fingerprint under `root`: build aside, then rename, so
// a concurrent job never sees a half-written harness.
function stage(harness, root) {
  const dir = path.join(root, harness.fingerprint.slice(0, 32));
  if (fs.existsSync(path.join(dir, "ready"))) return describe(harness, dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = `${dir}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const write = (rel, body) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, body, { mode: 0o600 });
  };
  try {
    for (const d of ["config", "xdg-config"]) fs.mkdirSync(path.join(tmp, d), { recursive: true, mode: 0o700 });
    for (const [rel, body] of Object.entries(harness.files)) {
      const sub = SUBAGENT.exec(rel);
      if (sub) write(path.join("config", "agent", `${sub[1]}.md`), body);
      else if (rel.startsWith("skills/") || rel.startsWith("plugin/")) write(path.join("config", rel), body);
      else if (rel.startsWith("scripts/")) write(rel, body);
    }
    write("instructions.md", instructions(harness, path.join(dir, "scripts")));
    write("ready", harness.fingerprint);
    try { fs.renameSync(tmp, dir); }
    catch (e) { if (!fs.existsSync(path.join(dir, "ready"))) throw e; fs.rmSync(tmp, { recursive: true, force: true }); }
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  return describe(harness, dir);
}

// Stage the harness a job was admitted with, refusing one that changed since.
function prepare({ dir, fingerprint }, root) {
  const harness = read(dir);
  if (harness.fingerprint !== fingerprint) throw new Error("The harness directory changed after the job was submitted; resubmit to run the current harness");
  return stage(harness, root);
}

// The scoped worker's bounded tool set, plus the tools the harness's own
// components need: `skill` to load its skills, `task` to reach its subagents.
function agentConfig(staged, { steps = 24 } = {}) {
  const permission = { "*": "deny", ...Object.fromEntries(workerProfile.CORE.map(k => [k, "allow"])), external_directory: "allow" };
  if (staged.skills) permission.skill = "allow";
  if (staged.subagents) permission.task = "allow";
  return { description: "OmniWork worker running a Harness² harness", mode: "primary", hidden: true, steps, permission };
}
function permissions(staged, mode) {
  const rules = workerProfile.permissions(mode);
  if (staged.skills) rules.push({ permission: "skill", pattern: "*", action: "allow" });
  if (staged.subagents) rules.push({ permission: "task", pattern: "*", action: mode === "plan" ? "deny" : mode === "auto" ? "allow" : "ask" });
  return rules;
}
function engineConfig(staged, { steps = 24 } = {}) {
  return { ...(staged.instructions ? { instructions: [staged.instructions] } : {}), agent: { [AGENT]: agentConfig(staged, { steps }) } };
}
function engineEnv(staged) {
  return { OPENCODE_CONFIG_DIR: staged.configDir, XDG_CONFIG_HOME: staged.xdgConfigHome, OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" };
}

module.exports = { AGENT, ALWAYS_ON, LIMITS, read, instructions, stage, prepare, agentConfig, permissions, engineConfig, engineEnv };
