"use strict";
// Agent tools: the file + shell primitives that make OmniWork a real coding agent.
// All paths are resolved against, and confined to, the active workspace directory.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_READ_BYTES = 400 * 1024; // don't blow up context on huge files
const MAX_OUTPUT_CHARS = 30000;

function confine(workspace, target) {
  const abs = path.resolve(workspace, target);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${target}`);
  }
  return abs;
}

// ---- Tool schema advertised to the model (OpenAI tool-calling format) ----
const TOOL_SCHEMA = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a directory relative to the workspace root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path, '.' for root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file's contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content. Creates parent dirs as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace the first exact occurrence of old_string with new_string in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace and return combined stdout/stderr. Use for builds, tests, git, etc.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL over HTTP and return its text content (HTML is stripped to readable text). Use to read docs, APIs, or web pages.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "Open a URL in the user's default browser. Use when the user should see a page, a running dev server, a PR, or docs.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
];

function truncate(s) {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n… [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

async function runCommand(workspace, command, onChunk) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell.exe" : "/bin/bash";
    const args = isWin ? ["-NoProfile", "-Command", command] : ["-lc", command];
    const child = spawn(shell, args, { cwd: workspace, env: process.env });
    let out = "";
    const push = (d) => {
      const t = d.toString();
      out += t;
      if (onChunk) onChunk(t);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => resolve(`Failed to start command: ${e.message}`));
    child.on("close", (code) => {
      resolve(truncate(out.trim() + `\n\n[exit code ${code}]`));
    });
  });
}

async function webFetch(url) {
  let u = String(url || "");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const res = await fetch(u, { redirect: "follow", headers: { "User-Agent": "OmniWork/0.2" } });
    const type = res.headers.get("content-type") || "";
    let body = await res.text();
    if (type.includes("html")) {
      body = body
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
    }
    return truncate(`[${res.status}] ${u}\n\n${body}`);
  } catch (err) {
    return `Failed to fetch ${u}: ${err.message}`;
  }
}

// ---- Dispatcher. Returns a string result for the given tool call. ----
async function executeTool(name, args, ctx) {
  const { workspace, onChunk } = ctx;
  try {
    switch (name) {
      case "list_dir": {
        const dir = confine(workspace, args.path || ".");
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        if (!entries.length) return "(empty directory)";
        return entries
          .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
          .sort()
          .join("\n");
      }
      case "read_file": {
        const file = confine(workspace, args.path);
        const stat = fs.statSync(file);
        if (stat.size > MAX_READ_BYTES) {
          return `File too large (${stat.size} bytes). Read a smaller file or use run_command with head/Select-Object.`;
        }
        return fs.readFileSync(file, "utf8");
      }
      case "write_file": {
        const file = confine(workspace, args.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, args.content ?? "", "utf8");
        return `Wrote ${Buffer.byteLength(args.content ?? "")} bytes to ${args.path}`;
      }
      case "edit_file": {
        const file = confine(workspace, args.path);
        const cur = fs.readFileSync(file, "utf8");
        if (!cur.includes(args.old_string)) {
          return `old_string not found in ${args.path}. Read the file first to copy exact text.`;
        }
        const next = cur.replace(args.old_string, args.new_string);
        fs.writeFileSync(file, next, "utf8");
        return `Edited ${args.path}`;
      }
      case "run_command": {
        return await runCommand(workspace, args.command, onChunk);
      }
      case "web_fetch": {
        return await webFetch(args.url);
      }
      case "open_url": {
        const { shell } = require("electron");
        let u = String(args.url || "");
        if (!/^https?:\/\//i.test(u)) u = "http://" + u;
        await shell.openExternal(u);
        return `Opened ${u} in the browser.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error in ${name}: ${err.message}`;
  }
}

module.exports = { TOOL_SCHEMA, executeTool };
