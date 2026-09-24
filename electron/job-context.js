"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const cache = new Map();
const ignored = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git)(\/|$)|(?:\.min\.js|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
// A bounded, deterministic orientation map. No embedding/model call, and no
// claim of semantic completeness. Content-addressed trees share the file index.
async function orientation(spec, workspace, git) {
  if (!workspace.isolated) return "";
  const key = `${workspace.sourceRoot}:${workspace.baseTree}`;
  if (!cache.has(key)) {
    const promise = git(workspace.sourceRoot, ["ls-tree", "-r", "--name-only", "-z", workspace.baseTree]).then(text => text.split("\0").filter(f => f && !ignored.test(f)));
    cache.set(key, promise); promise.catch(() => cache.delete(key));
    if (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  const files = await cache.get(key);
  const terms = [...new Set((spec.task.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []).filter(t => !["file", "create", "implement", "with", "that", "this", "test", "tests"].includes(t)))];
  const requested = [...spec.context_files, ...spec.allowed_paths].map(p => path.posix.join(workspace.relativeCwd.replace(/\\/g, "/"), p));
  const ranked = files.map(file => ({ file, score: terms.reduce((n,t) => n + (file.toLowerCase().includes(t) ? 2 : 0), 0) + (requested.some(p => p === file || (p.endsWith("/") && file.startsWith(p))) ? 10 : 0) })).sort((a,b) => b.score - a.score || a.file.localeCompare(b.file));
  const lines = ["Repository orientation (selected paths and declarations; read source before editing):"];
  for (const { file, score } of ranked.slice(0, 24)) {
    lines.push(file);
    if (score <= 0 || !/\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|cs)$/.test(file)) continue;
    const full = path.join(workspace.tree, file);
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.size > 200000) continue;
    const source = await fs.readFile(full, "utf8");
    const declarations = source.split("\n").map((s,i) => ({s,i})).filter(({s}) => /^\s*(?:(?:export|public|private|static|async|default)\s+)*(?:class|interface|type|function|def|fn|func|struct|enum)\s+[\w$]+/.test(s)).slice(0, 8);
    for (const {s,i} of declarations) lines.push(`  ${i+1}: ${s.trim().slice(0,140)}`);
    if (lines.join("\n").length > 4000) break;
  }
  return lines.join("\n").slice(0,4000);
}
module.exports = { orientation };
