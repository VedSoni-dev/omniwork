"use strict";
// Agent tools: the file + shell primitives that make OmniWork a real coding agent.
// All paths are resolved against, and confined to, the active workspace directory.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { commandEnv, inheritsCommandEnv } = require("./child-env");

const MAX_READ_BYTES = 400 * 1024; // don't blow up context on huge files
const MAX_OUTPUT_CHARS = 48000;

// path.resolve + path.relative is only a text check: a symlink committed
// inside a repo (docs/x -> ~/.ssh) passes it, and the read or write then
// follows the link out. So both sides are compared as real paths — for a
// target that doesn't exist yet, its nearest existing ancestor — and a write
// never goes through a symlink, even one that points back inside.
function confine(workspace, target, { write = false } = {}) {
  const root = fs.realpathSync(workspace);
  const wanted = path.resolve(workspace, String(target ?? ""));
  let existing = wanted;
  const rest = [];
  let stat = null;
  while (!stat) {
    try { stat = fs.lstatSync(existing); }
    catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      const parent = path.dirname(existing);
      if (parent === existing) throw e;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  if (write && !rest.length && stat.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${target}`);
  let real;
  try { real = path.join(fs.realpathSync(existing), ...rest); }
  catch { throw new Error(`Path escapes workspace or is a broken link: ${target}`); }
  const rel = path.relative(root, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${target}`);
  }
  return real;
}

// O_NOFOLLOW closes the gap between confine() and the write: a link swapped
// in at the final component meanwhile fails the open instead of being followed.
function writeConfined(file, text) {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
  if (O_NOFOLLOW === undefined) return fs.writeFileSync(file, text, "utf8");
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o666);
  try { fs.writeFileSync(fd, text, "utf8"); } finally { fs.closeSync(fd); }
}

// What a write_file/edit_file call would change, for approval prompts and ACP
// diffs. Same confinement as the tool itself: a preview that read through a
// symlink would show the user (or an ACP client) a file outside the workspace.
function previewEdit(workspace, name, args = {}) {
  if ((name !== "write_file" && name !== "edit_file") || !args.path) return null;
  try {
    const file = confine(workspace, args.path, { write: true });
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (name === "write_file") return { path: file, oldText: old, newText: String(args.content ?? ""), created: old === null };
    if (old != null && args.old_string != null && old.includes(args.old_string)) {
      return { path: file, oldText: old, newText: old.replace(args.old_string, args.new_string ?? ""), created: false };
    }
  } catch {}
  return null;
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
      description: "Read a UTF-8 text file. Defaults to the first 200 lines; use start_line/end_line for targeted reads (up to 400 lines).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
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

// Keep the head AND the tail. A head-only cut drops the end of a command's
// output — which is exactly where the error message and the [exit code N]
// marker live — so the model (and the escalation heuristic) lose the signal
// that the command failed. The gateway's RTK pass then compresses what remains.
function truncate(s) {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const tail = Math.min(8000, Math.floor(MAX_OUTPUT_CHARS / 4)); // room for errors + exit code
  const head = MAX_OUTPUT_CHARS - tail;
  return s.slice(0, head) + `\n… [truncated ${s.length - MAX_OUTPUT_CHARS} chars]\n` + s.slice(-tail);
}

// The user's shell, so commands behave as they would in Terminal, with the
// environment from child-env.js. Not a login shell: that would re-source the
// profile and re-export the secrets commandEnv() leaves out. macOS defaults to
// zsh; bash is the fallback.
function userShell() {
  if (process.platform === "win32") return "powershell.exe";
  const sh = process.env.SHELL;
  if (sh && fs.existsSync(sh)) return sh;
  return fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
}

async function runCommand(workspace, command, onChunk, signal) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = userShell();
    const args = isWin ? ["-NoProfile", "-Command", command] : [inheritsCommandEnv() ? "-lc" : "-c", command];
    if (signal?.aborted) return resolve({ text: "Command cancelled", ok: false, exitCode: null });
    const child = spawn(shell, args, { cwd: workspace, env: commandEnv(workspace), detached: !isWin });
    let killTimer;
    const kill = (hard = false) => {
      try {
        if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
        else process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM");
      } catch {}
    };
    const abort = () => { kill(); killTimer = setTimeout(() => kill(true), 500); killTimer.unref(); };
    signal?.addEventListener("abort", abort, { once: true });
    let out = "";
    const push = (d) => {
      const t = d.toString();
      out += t;
      if (out.length > 2_000_000) { out = out.slice(0, 1_000_000) + "\n[command output exceeded 2MB; command stopped]\n" + out.slice(-100_000); kill(); }
      if (onChunk) onChunk(t);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => { signal?.removeEventListener("abort", abort); resolve({ text: `Failed to start command: ${e.message}`, ok: false, exitCode: null }); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      // The shell can exit before descendants which ignored SIGTERM.
      // Kill the remaining process group before cancelling the escalation.
      if (killTimer) { kill(true); clearTimeout(killTimer); }
      resolve({ text: out.trim() + `\n\n[exit code ${code}]`, ok: code === 0 && !signal?.aborted, exitCode: code });
    });
  });
}

async function webFetch(url, signal) {
  let u = String(url || "");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const res = await fetch(u, { signal, redirect: "follow", headers: { "User-Agent": "OmniWork/0.2" } });
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

// The OS opener for a URL, never through a shell. Windows used to run
// `start <url>` under cmd.exe, which doesn't escape arguments, so a model
// asked to open `https://x.test/?a=1&calc.exe` ran calc.exe — a command behind
// an approval that read "Open …". rundll32's FileProtocolHandler takes the URL
// as an argument. Only http(s) URLs are opened, re-serialized by URL, which
// percent-encodes spaces and quotes.
function openerCommand(url, platform = process.platform) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw new Error(`not a URL: ${url}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`only http(s) URLs can be opened, not ${parsed.protocol}`);
  const href = parsed.href;
  if (platform === "win32") return { href, cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", href] };
  return { href, cmd: platform === "darwin" ? "open" : "xdg-open", args: [href] };
}

// Open a URL in the default browser. Uses Electron's shell when we're inside the
// app; mcp-server.js runs on plain Node, where `require("electron")` resolves to
// a path string rather than the module, so fall back to the OS opener.
async function openExternal(url) {
  const { href, cmd, args } = openerCommand(url);
  try {
    const electron = require("electron");
    if (electron && electron.shell && typeof electron.shell.openExternal === "function") {
      await electron.shell.openExternal(href);
      return;
    }
  } catch {}
  await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", resolve);
    child.on("spawn", () => { child.unref(); resolve(); });
  });
}

// ---- Dispatcher. Returns a string result for the given tool call. ----
async function executeRaw(name, args, ctx) {
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
          return `Error in read_file: file too large (${stat.size} bytes). Read a smaller file or use run_command with head/Select-Object.`;
        }
        const lines = fs.readFileSync(file, "utf8").split("\n");
        const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
        const end = Math.min(lines.length, start + 399, Math.max(start, Math.floor(Number(args.end_line) || start + 199)));
        return lines.slice(start - 1, end).join("\n") + (start > 1 || end < lines.length ? `\n[lines ${start}-${end} of ${lines.length}${end < lines.length ? `; next start_line=${end + 1}` : ""}]` : "");
      }
      case "write_file": {
        const file = confine(workspace, args.path, { write: true });
        if (ctx.recordUndo) ctx.recordUndo(args.path, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeConfined(file, args.content ?? "");
        return `Wrote ${Buffer.byteLength(args.content ?? "")} bytes to ${args.path}`;
      }
      case "edit_file": {
        const file = confine(workspace, args.path, { write: true });
        const cur = fs.readFileSync(file, "utf8");
        if (!cur.includes(args.old_string)) {
          return `Error in edit_file: old_string not found in ${args.path}. Read the file first to copy exact text.`;
        }
        if (ctx.recordUndo) ctx.recordUndo(args.path, cur);
        const next = cur.replace(args.old_string, args.new_string);
        writeConfined(file, next);
        return `Edited ${args.path}`;
      }
      case "run_command": {
        return await runCommand(workspace, args.command, onChunk, ctx.signal);
      }
      case "web_fetch": {
        return await webFetch(args.url, ctx.signal);
      }
      case "open_url": {
        let u = String(args.url || "");
        if (!/^https?:\/\//i.test(u)) u = "http://" + u;
        await openExternal(u);
        return `Opened ${u} in the browser.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error in ${name}: ${err.message}`;
  }
}

async function executeToolResult(name, args, ctx) {
  const raw = await executeRaw(name, args, ctx);
  if (raw && typeof raw === "object") return raw;
  const text = String(raw);
  const ok = !/^(Error in |Failed to |Unknown tool:|File too large)/.test(text);
  return { text, ok, changed: ok && (name === "write_file" || name === "edit_file") };
}
async function executeTool(name, args, ctx) {
  return truncate((await executeToolResult(name, args, ctx)).text);
}
module.exports = { TOOL_SCHEMA, executeTool, executeToolResult, confine, writeConfined, previewEdit, openerCommand };
