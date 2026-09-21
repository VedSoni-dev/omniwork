"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

async function git(cwd, args, options = {}) {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 60_000, ...options });
  return stdout;
}
function relativeFile(file) {
  if (typeof file !== "string" || !file || path.isAbsolute(file) || file.split(/[\\/]/).some(p => p === ".." || p === ".git") || file.includes("\0")) throw new Error("File paths must be relative and cannot traverse directories or target .git");
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

// Snapshot tracked edits and nonignored new files through a private index.
// The user's index, branch and working directory are never changed.
async function snapshot(root, dir) {
  const index = path.join(dir, `index-${require("node:crypto").randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" };
  try {
    await git(root, ["read-tree", "HEAD"], { env });
    await git(root, ["add", "-A", "--", "."], { env });
    return (await git(root, ["write-tree"], { env })).trim();
  } finally { await fs.rm(index, { force: true }); await fs.rm(index + ".lock", { force: true }); }
}
async function prepare(spec, dir) {
  if (spec.isolation === "shared") return { cwd: spec.cwd, sourceRoot: spec.cwd, isolated: false };
  const root = (await git(spec.cwd, ["rev-parse", "--show-toplevel"])).trim();
  const sourceRoot = await fs.realpath(root);
  const sourceCwd = await fs.realpath(spec.cwd);
  const relativeCwd = path.relative(sourceRoot, sourceCwd);
  const baseCommit = (await git(sourceRoot, ["rev-parse", "HEAD"])).trim();
  const baseTree = await snapshot(sourceRoot, dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: "OmniWork", GIT_AUTHOR_EMAIL: "omniwork@localhost", GIT_COMMITTER_NAME: "OmniWork", GIT_COMMITTER_EMAIL: "omniwork@localhost" };
  const snapshotCommit = (await git(sourceRoot, ["commit-tree", baseTree, "-p", baseCommit, "-m", "OmniWork isolated task snapshot"], { env })).trim();
  const tree = path.join(dir, "worktree");
  await git(sourceRoot, ["worktree", "add", "--detach", "--quiet", tree, snapshotCommit]);
  return { cwd: path.join(tree, relativeCwd), tree, sourceRoot, sourceCwd, relativeCwd, baseCommit, baseTree, snapshotCommit, isolated: true };
}
async function collect(workspace, dir, allowedPaths = []) {
  if (!workspace.isolated) return { isolated: false, files: [], patch: null };
  await git(workspace.tree, ["add", "-A", "--", "."]);
  const files = (await git(workspace.tree, ["diff", "--cached", "--no-renames", "--name-only", "-z", workspace.baseTree])).split("\0").filter(Boolean);
  const patch = await git(workspace.tree, ["diff", "--cached", "--no-renames", "--binary", workspace.baseTree]);
  const patchPath = path.join(dir, "changes.patch");
  await fs.writeFile(patchPath, patch, { mode: 0o600 });
  const allowed = allowedPaths.map(p => path.posix.join(workspace.relativeCwd.replace(/\\/g, "/"), p));
  const outsideScope = allowed.length ? files.filter(f => !allowed.some(p => f === p.replace(/\/$/, "") || (p.endsWith("/") && f.startsWith(p)))) : [];
  return { isolated: true, files, patch: patchPath, bytes: Buffer.byteLength(patch), outsideScope };
}
async function context(spec, workspace) {
  let left = 24000;
  const parts = [];
  for (const name of spec.context_files || []) {
    const absolute = await fs.realpath(path.join(workspace.cwd, name));
    const rel = path.relative(await fs.realpath(workspace.cwd), absolute);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Context file escapes workspace: ${name}`);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Context file is not a small regular file: ${name}`);
    const text = await fs.readFile(absolute, "utf8");
    const take = Math.min(left, 8000);
    parts.push(`File: ${name}\n${text.slice(0, take)}${text.length > take ? "\n[excerpt; read the file for more]" : ""}`);
    left -= Math.min(take, text.length);
    if (left <= 0) break;
  }
  return [spec.task,
    spec.allowed_paths.length ? `Own only these paths (directory entries end in /): ${spec.allowed_paths.join(", ")}. Other workers run independently; do not edit outside your ownership.` : "",
    spec.checks.length ? `Acceptance commands (do not weaken or remove tests to pass):\n${spec.checks.join("\n")}` : "",
    await require("./job-context").orientation(spec, workspace, git), ...parts,
  ].filter(Boolean).join("\n\n");
}

async function apply(job, dir, runCheck) {
  const w = job.workspace, artifact = job.artifact;
  if (!w?.isolated || !artifact?.patch) throw new Error("Only isolated jobs have an applicable patch");
  if (job.status !== "completed" || artifact.outsideScope?.length) throw new Error("Only completed jobs within their allowed paths can be applied");
  if (!job.spec.checks.length || job.result?.verification?.status !== "passed") throw new Error("Application requires passing acceptance checks");
  if (job.appliedAt) return { appliedAt: job.appliedAt, alreadyApplied: true };
  if (!artifact.files.length) return { appliedAt: new Date().toISOString(), files: [], checks: [] };
  const currentTree = await snapshot(w.sourceRoot, dir);
  // Refuse overlapping edits, including binary changes, additions and removals.
  for (const file of artifact.files) {
    const before = await git(w.sourceRoot, ["ls-tree", w.baseTree, "--", file]);
    const now = await git(w.sourceRoot, ["ls-tree", currentTree, "--", file]);
    if (before !== now) throw new Error(`Source changed since submission: ${file}. Rebase/review the patch before applying.`);
  }
  const integration = path.join(dir, "integration");
  await git(w.sourceRoot, ["worktree", "add", "--detach", "--quiet", integration, w.snapshotCommit]);
  const checks = [];
  try {
    await git(integration, ["read-tree", "--reset", "-u", currentTree]);
    await git(integration, ["apply", "--binary", artifact.patch]);
    const expectedTree = await snapshot(integration, dir);
    for (const command of [...job.spec.setup, ...job.spec.checks]) {
      const r = await runCheck(command, path.join(integration, w.relativeCwd));
      checks.push({ command, ok: r.ok, exitCode: r.exitCode, output: r.text.slice(-8000) });
      if (!r.ok) return { applied: false, reason: "Integration check failed", checks };
    }
    const testedTree = await snapshot(integration, dir);
    for (const file of artifact.files) {
      if (await git(integration, ["ls-tree", expectedTree, "--", file]) !== await git(integration, ["ls-tree", testedTree, "--", file])) throw new Error(`Acceptance/setup commands changed a patch file: ${file}; review the generated changes before applying`);
    }
    if (await snapshot(w.sourceRoot, dir) !== currentTree) throw new Error("Source changed during integration checks; retry application");
    await git(w.sourceRoot, ["apply", "--check", "--binary", artifact.patch]);
    await git(w.sourceRoot, ["apply", "--binary", artifact.patch]);
    return { applied: true, appliedAt: new Date().toISOString(), files: artifact.files, checks };
  } finally { await git(w.sourceRoot, ["worktree", "remove", "--force", integration]).catch(() => {}); }
}
module.exports = { git, relativeFile, snapshot, prepare, collect, context, apply };
