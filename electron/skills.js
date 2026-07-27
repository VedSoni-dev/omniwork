"use strict";
// Skills: reusable instruction packs the agent loads on demand — the same
// SKILL.md format Claude Code uses (YAML-ish frontmatter + markdown body), so
// existing skill repos install unchanged.
//
//   userData/skills/<name>/SKILL.md          global — every project & session
//   <workspace>/.omniwork/skills/<name>/     project — travels with the repo
//
// The system prompt carries only name + description per skill; the body loads
// through the use_skill tool when the task actually matches (progressive
// disclosure — a dozen installed skills cost a few hundred prompt tokens).
// Installing from git/folder copies the directories that contain a SKILL.md.
// Nothing from the source is ever executed — not at install time, not later;
// skills are instructions the model reads, not code that runs. Note the copy is
// of the whole skill directory, so a source can leave inert files alongside
// SKILL.md.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_SKILL_BODY = 16_000; // chars returned by use_skill

const USE_SKILL_TOOL = {
  type: "function",
  function: {
    name: "use_skill",
    description: "Load a skill's full instructions. Call this FIRST when the task matches an available skill, then follow the instructions it returns.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name from the available-skills list." } },
      required: ["name"],
    },
  },
};

const SAVE_SKILL_TOOL = {
  type: "function",
  function: {
    name: "save_skill",
    description: "Save a reusable workflow as a global skill for future sessions (available in every project). Use when the user asks to save a workflow, or a multi-step process is clearly worth repeating.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short kebab-case name, e.g. deploy-checklist." },
        description: { type: "string", description: "One line: when to use this skill." },
        instructions: { type: "string", description: "The full markdown instructions the skill loads." },
      },
      required: ["name", "description", "instructions"],
    },
  },
};

const INSTALL_SKILLS_TOOL = {
  type: "function",
  function: {
    name: "install_skills",
    description: "Install skills into the user's global environment from a git repo URL, GitHub owner/repo shorthand, or local folder. Only SKILL.md directories are copied — nothing from the source is executed. Use after locating a skill repo the user asked for.",
    parameters: {
      type: "object",
      properties: { source: { type: "string", description: "Git URL, owner/repo, or local folder path." } },
      required: ["source"],
    },
  },
};

const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// Minimal frontmatter parse: --- name: x / description: y --- body
function parseSkill(text) {
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: null, description: "", body: String(text) };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { name: meta.name || null, description: meta.description || "", body: m[2] };
}

function skillsIn(root, scope) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, "SKILL.md");
    try {
      const parsed = parseSkill(fs.readFileSync(file, "utf8"));
      out.push({ name: parsed.name || e.name, description: parsed.description, scope, file });
    } catch {}
  }
  return out;
}

// Project skills shadow global ones with the same name.
function listSkills(globalDir, workspace) {
  const seen = new Map();
  for (const s of skillsIn(globalDir, "global")) seen.set(s.name, s);
  if (workspace) for (const s of skillsIn(path.join(workspace, ".omniwork", "skills"), "project")) seen.set(s.name, s);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readSkill(globalDir, workspace, name) {
  const s = listSkills(globalDir, workspace).find((x) => x.name === name);
  if (!s) return `No skill named "${name}". Available: ${listSkills(globalDir, workspace).map((x) => x.name).join(", ") || "none"}.`;
  const { body } = parseSkill(fs.readFileSync(s.file, "utf8"));
  return body.trim().slice(0, MAX_SKILL_BODY) || "(This skill has no instructions yet.)";
}

function promptSection(globalDir, workspace) {
  const list = listSkills(globalDir, workspace);
  if (!list.length) return "";
  const lines = list.map((s) => `- ${s.name}: ${s.description || "(no description)"}`);
  return `\n\n## Available skills\nWhen a task matches one of these, call use_skill with its name FIRST and follow the returned instructions.\n${lines.join("\n")}`;
}

function createSkill(globalDir, name, description, instructions) {
  const n = slug(name);
  if (!n) throw new Error("invalid skill name");
  const dir = path.join(globalDir, n);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${n}\ndescription: ${String(description || "").replace(/\n/g, " ")}\n---\n\n${instructions || `# ${n}\n\nDescribe the steps the agent should follow here.\n`}`);
  return { name: n, file };
}

// Install from a git URL, GitHub owner/repo shorthand, or local folder.
// Scans (depth-limited) for directories containing SKILL.md and copies them.
async function installSkills(globalDir, source) {
  let src = String(source || "").trim();
  if (!src) throw new Error("usage: /skill:install <git url, owner/repo, or folder>");
  let cleanup = null;
  if (!fs.existsSync(src)) {
    if (/^[\w.-]+\/[\w.-]+$/.test(src)) src = `https://github.com/${src}.git`;

    // `install_skills` is agent-callable, so `source` can be steered by prompt
    // injection in anything the model read. Constrain it to real remote URLs
    // before it reaches git: a leading "-" would be parsed as a flag (e.g.
    // --upload-pack=<cmd>), and git's ext:: transport runs an arbitrary command.
    // Neither fires on a current git with default config, but this path is one
    // refactor away from being live, and the check costs nothing.
    if (!/^https:\/\/|^git@|^ssh:\/\/|^git:\/\//.test(src)) {
      throw new Error(`refusing to clone "${source}" — use an https:// or ssh git URL, owner/repo, or an existing local folder path`);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-skill-"));
    await new Promise((resolve, reject) => {
      // `--` stops git parsing anything after it as an option.
      execFile("git", ["clone", "--depth", "1", "--", src, tmp], { timeout: 60_000 }, (err) => (err ? reject(new Error("git clone failed: " + err.message)) : resolve()));
    });
    cleanup = tmp;
    src = tmp;
  }
  const found = [];
  (function scan(dir, depth) {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) { found.push(dir); return; }
    for (const e of entries) {
      if (e.isDirectory() && !["node_modules", ".git"].includes(e.name)) scan(path.join(dir, e.name), depth + 1);
    }
  })(src, 0);
  const installed = [];
  for (const dir of found) {
    const parsed = parseSkill(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
    const name = slug(parsed.name || path.basename(dir));
    if (!name) continue;
    const dest = path.join(globalDir, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(dir, dest, { recursive: true });
    installed.push(name);
  }
  if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
  return installed;
}

module.exports = { USE_SKILL_TOOL, SAVE_SKILL_TOOL, INSTALL_SKILLS_TOOL, parseSkill, listSkills, readSkill, promptSection, createSkill, installSkills };
