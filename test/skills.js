// Unit test: SKILL.md parsing, create, scoped listing (project shadows
// global), read, and install from a local folder. No gateway, no git needed.
const fs = require("fs"), os = require("os"), path = require("path");
const { parseSkill, listSkills, readSkill, promptSection, createSkill, installSkills } = require("../electron/skills");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

const g = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sk-g-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sk-ws-"));

// frontmatter parsing (Claude Code-compatible format)
const parsed = parseSkill("---\nname: browse\ndescription: Drive a headless browser.\n---\n\n# Steps\nDo things.");
check("frontmatter parsed", parsed.name === "browse" && parsed.description === "Drive a headless browser." && parsed.body.includes("# Steps"));
check("no frontmatter → body only", parseSkill("just text").name === null);

// create + list + read
createSkill(g, "Deploy Checklist!", "Steps to deploy safely.", "1. Run tests\n2. Ship");
const list1 = listSkills(g, null);
check("create slugifies name", list1.length === 1 && list1[0].name === "deploy-checklist");
check("read returns body", readSkill(g, null, "deploy-checklist").includes("1. Run tests"));
check("read unknown → helpful error", readSkill(g, null, "nope").includes('No skill named "nope"'));
check("prompt section lists skills", promptSection(g, null).includes("deploy-checklist: Steps to deploy safely."));

// project scope shadows global
const pDir = path.join(ws, ".omniwork", "skills", "deploy-checklist");
fs.mkdirSync(pDir, { recursive: true });
fs.writeFileSync(path.join(pDir, "SKILL.md"), "---\nname: deploy-checklist\ndescription: Project-specific deploy.\n---\nProject steps.");
const list2 = listSkills(g, ws);
check("project shadows global", list2.length === 1 && list2[0].scope === "project");
check("read resolves to project version", readSkill(g, ws, "deploy-checklist").includes("Project steps"));

// install from a local folder (repo layout: skills nested in subdirs)
(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sk-repo-"));
  for (const n of ["browse", "qa"]) {
    fs.mkdirSync(path.join(repo, "skills", n), { recursive: true });
    fs.writeFileSync(path.join(repo, "skills", n, "SKILL.md"), `---\nname: ${n}\ndescription: The ${n} skill.\n---\nInstructions for ${n}.`);
  }
  fs.writeFileSync(path.join(repo, "README.md"), "not a skill");
  const installed = await installSkills(g, repo);
  check("install finds nested skills", installed.sort().join(",") === "browse,qa");
  check("installed skills listed globally", listSkills(g, null).length === 3);
  check("installed skill readable", readSkill(g, null, "browse").includes("Instructions for browse"));
  const again = await installSkills(g, repo);
  check("reinstall overwrites cleanly", again.length === 2 && listSkills(g, null).length === 3);

  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ SKILLS TEST PASSED");
  process.exit(fails ? 1 : 0);
})();
