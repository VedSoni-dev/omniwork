"use strict";
// Durable agent memory: one MEMORY.md per scope (global + per-project).
// Entries are appended as short markdown bullets; the whole file is injected
// into the system prompt each turn (capped). Plain markdown on disk — the
// user can read, edit, or delete memory with any editor.

const fs = require("node:fs");
const path = require("node:path");

const MAX_INJECT = 8000; // chars across both scopes

const MEMORY_TOOL = {
  type: "function",
  function: {
    name: "save_memory",
    description:
      "Save a durable fact to memory so future sessions recall it. Use for user preferences, project conventions, and hard-won fixes — not session trivia. scope 'project' = this project only; 'global' = every project.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["project", "global"], description: "Where the fact applies." },
        title: { type: "string", description: "Short label for the fact." },
        content: { type: "string", description: "The fact itself, 1–3 sentences." },
      },
      required: ["scope", "title", "content"],
    },
  },
};

function memoryFile(dir) { return path.join(dir, "MEMORY.md"); }

// ── project knowledge ────────────────────────────────────────────────
// Files the user adds to a project for the agent to consult. The prompt
// carries only the file list; bodies load through read_knowledge.

const MAX_KNOWLEDGE_READ = 24_000; // chars per file read

const KNOWLEDGE_TOOL = {
  type: "function",
  function: {
    name: "read_knowledge",
    description: "Read a file from this project's knowledge folder (documents the user uploaded as reference context). Call when a listed knowledge file is relevant to the task.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "File name from the project-knowledge list." } },
      required: ["name"],
    },
  },
};

function listKnowledge(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size }));
  } catch { return []; }
}

function knowledgeSection(dir) {
  const files = dir ? listKnowledge(dir) : [];
  if (!files.length) return "";
  const lines = files.map((f) => `- ${f.name} (${f.size > 1024 ? Math.round(f.size / 1024) + " KB" : f.size + " B"})`);
  return `\n\n## Project knowledge (user-uploaded reference files)\nRead one with read_knowledge when relevant:\n${lines.join("\n")}`;
}

function readKnowledge(dir, name) {
  const base = path.basename(String(name || "")); // no path escapes
  const file = path.join(dir, base);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const have = listKnowledge(dir).map((f) => f.name).join(", ");
    return `No knowledge file named "${base}". Available: ${have || "none"}.`;
  }
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return `"${base}" is a binary file (${buf.length} bytes) — cannot read as text.`;
  const text = buf.toString("utf8");
  return text.length > MAX_KNOWLEDGE_READ ? text.slice(0, MAX_KNOWLEDGE_READ) + `\n…(truncated, ${text.length} chars total)` : text;
}

function saveMemory(dir, title, content) {
  fs.mkdirSync(dir, { recursive: true });
  const file = memoryFile(dir);
  const head = fs.existsSync(file) ? "" : "# Memory\n\n";
  const entry = `- **${String(title).trim()}** — ${String(content).trim().replace(/\s*\n\s*/g, " ")}\n`;
  fs.appendFileSync(file, head + entry, "utf8");
  return `Saved to memory: ${title}`;
}

function readMemory(dir) {
  try { return fs.readFileSync(memoryFile(dir), "utf8").trim(); } catch { return ""; }
}

// Combined prompt section for both scopes; newest entries win the cap.
function loadForPrompt(globalDir, projectDir) {
  let out = "";
  const g = globalDir ? readMemory(globalDir) : "";
  const p = projectDir ? readMemory(projectDir) : "";
  if (g) out += `\n\n## Global memory\n${g}`;
  if (p) out += `\n\n## Project memory\n${p}`;
  if (out.length > MAX_INJECT) out = out.slice(-MAX_INJECT);
  return out.trim();
}

module.exports = { MEMORY_TOOL, saveMemory, loadForPrompt, memoryFile, KNOWLEDGE_TOOL, listKnowledge, knowledgeSection, readKnowledge };
