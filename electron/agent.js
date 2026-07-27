"use strict";
// The agent loop. Talks to the local OmniRoute gateway (OpenAI-compatible /v1)
// and runs a tool-use loop until the model produces a final answer.
//
// An orchestrator agent can fan work out to parallel subagents via the
// `spawn_subagents` tool — the "Agent Deck". Subagents run concurrently, each
// with its own context/tool-loop, and report a summary back to the parent.

const { TOOL_SCHEMA, executeTool } = require("./tools");
const { MEMORY_TOOL, saveMemory, loadForPrompt } = require("./memory");
const { DEFAULT_CONTEXT, estimateTokens, shouldCompact, compact } = require("./compactor");
const skills = require("./skills");

const BASE_PROMPT = `You are OmniWork, an autonomous coding agent running on the user's machine, in the style of Claude Code.
You have direct access to the user's workspace through tools: list_dir, read_file, write_file, edit_file, run_command, web_fetch, open_url.
You can also browse the real internet: web_search finds pages, browse_page opens them in a real browser (renders JavaScript) and returns their text and links.
When the user asks for a skill or capability you don't have, find it yourself: web_search for it (add terms like "SKILL.md" or "claude skill"), browse_page the repo to confirm it contains skills, then install_skills with the repo URL — the new skills are usable immediately.

Guidelines:
- Be concise and direct. Do the work; don't just describe it.
- Explore before editing: read files to understand context before changing them.
- Make focused, correct edits. Prefer edit_file for surgical changes, write_file for new files.
- Use run_command for builds, tests, git, installing deps, and searching.
- Use web_fetch to read docs/APIs; open_url to show the user a page or running server.
- After changes, verify by running the relevant build/test/command when possible.
- When done, give a short summary of what you did.
- When you learn something durable — a user preference, a project convention, a hard-won fix —
  save it with save_memory so future sessions recall it. Don't save session trivia.`;

const ORCHESTRATOR_EXTRA = `

You can also delegate. When a task splits into INDEPENDENT parts that can run at the same time
(e.g. build several files, research multiple topics, refactor N modules), call spawn_subagents
with one entry per part. They run in parallel and each returns a summary you then synthesize.
Do NOT use subagents for small single-step work — just do it yourself.`;

const SUBAGENT_TOOL = {
  type: "function",
  function: {
    name: "spawn_subagents",
    description:
      "Fan work out to parallel subagents. Each subagent runs independently in the same workspace and returns a summary. Use for independent parallelizable subtasks; returns all summaries.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "The subtasks to run in parallel.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short label for this subagent." },
              prompt: { type: "string", description: "The full task instruction for the subagent." },
            },
            required: ["title", "prompt"],
          },
        },
      },
      required: ["tasks"],
    },
  },
};

const MAX_STEPS = 40;

const PLAN_MODE_PROMPT = `

# PLAN MODE
You are in plan mode: explore, analyze, and design — do NOT change anything.
File writes and edits are disabled; commands require the user's approval, so run only read-only ones.
End your reply with a clear, numbered plan and ask the user to switch modes (Shift+Tab) to execute it.`;

// Pure: what happens to a tool call under each approval mode.
// Returns "allow" | "ask" | "block".
function approvalDecision(mode, name, isMcpTool = false) {
  const isEdit = name === "write_file" || name === "edit_file";
  const isCmd = name === "run_command" || name === "install_skills" || isMcpTool;
  switch (mode) {
    case "ask": return isEdit || isCmd ? "ask" : "allow";
    case "edits": return isCmd ? "ask" : "allow";           // auto-accept file edits
    case "plan": return isEdit || name === "install_skills" ? "block" : (isCmd ? "ask" : "allow");
    default: return "allow";                                  // "auto"
  }
}

function subLabel(name, args) {
  const label = { run_command: "Bash", read_file: "Read", write_file: "Write", edit_file: "Edit", list_dir: "List", web_fetch: "Fetch", open_url: "Open" }[name] || name;
  const a = name === "run_command" ? args.command : args.path || args.url || "";
  return `${label} ${String(a || "").slice(0, 40)}`.trim();
}

class Agent {
  constructor({ baseUrl, apiKey, model, workspace, emit, mcp, memory = null, skillsDir = null, browser = null, canSpawn = true, depth = 0, approvalMode = "auto", approver = null }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model || "auto";
    this.workspace = workspace;
    this.emit = emit; // (event, payload) => void
    this.mcp = mcp || null;
    this.memory = memory; // { globalDir, projectDir } | null
    this.skillsDir = skillsDir || null; // global skills root
    this.browser = browser || null;    // BrowserManager
    this.contextTokens = DEFAULT_CONTEXT;
    this.canSpawn = canSpawn;
    this.depth = depth;
    this.approvalMode = approvalMode;   // "auto" | "ask"
    this.approver = approver;           // async (name, args) => boolean
    this.lastText = "";
    this.turnUndo = new Map();           // path -> original content (or null if newly created)
    this.undoAvailable = false;
    this.baseSystem = BASE_PROMPT + (canSpawn ? ORCHESTRATOR_EXTRA : "");
    this.messages = [{ role: "system", content: this.baseSystem }];
    this.aborted = false;
  }

  // Read project instruction files from the workspace (like Claude Code's CLAUDE.md).
  loadProjectMemory() {
    const fs = require("node:fs");
    const path = require("node:path");
    const files = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".omniwork.md", ".cursorrules"];
    let mem = "";
    for (const f of files) {
      try {
        const p = path.join(this.workspace, f);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) mem += `\n\n## ${f}\n${fs.readFileSync(p, "utf8").slice(0, 8000)}`;
      } catch {}
    }
    // Durable memory (global + this project) saved by past sessions.
    if (this.memory) {
      const saved = loadForPrompt(this.memory.globalDir, this.memory.projectDir);
      if (saved) mem += `\n\n${saved}`;
    }
    // Skills: names + descriptions only; bodies load via use_skill.
    if (this.skillsDir) mem += skills.promptSection(this.skillsDir, this.workspace);
    return mem.trim();
  }

  // Restore files changed during the last turn.
  undo() {
    const fs = require("node:fs");
    const path = require("node:path");
    if (!this.turnUndo.size) return "Nothing to undo.";
    let n = 0;
    for (const [rel, original] of this.turnUndo.entries()) {
      const abs = path.resolve(this.workspace, rel);
      try {
        if (original === null) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
        else fs.writeFileSync(abs, original, "utf8");
        n++;
      } catch {}
    }
    this.turnUndo = new Map();
    this.undoAvailable = false;
    return `Undid ${n} file change${n === 1 ? "" : "s"} from the last turn.`;
  }

  toolSchema() {
    const extra = this.mcp ? this.mcp.toolSchema() : [];
    const sub = this.canSpawn ? [SUBAGENT_TOOL] : [];
    const mem = this.memory ? [MEMORY_TOOL] : [];
    const sk = this.skillsDir ? [skills.USE_SKILL_TOOL, skills.SAVE_SKILL_TOOL, skills.INSTALL_SKILLS_TOOL] : [];
    const web = this.browser ? [require("./browser").WEB_SEARCH_TOOL, require("./browser").BROWSE_TOOL] : [];
    return [...TOOL_SCHEMA, ...sub, ...mem, ...sk, ...web, ...extra];
  }

  abort() { this.aborted = true; }
  setWorkspace(dir) { this.workspace = dir; }

  // One-off model call outside the session's message history (summaries,
  // titles, memory capture).
  async oneShot(prompt) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  #emitContext() {
    this.emit("context", { pct: Math.min(100, Math.round((estimateTokens(this.messages) / this.contextTokens) * 100)) });
  }

  // Compact when over threshold (or forced by /compact). Returns the notice, or null.
  async compactNow({ force = false } = {}) {
    if (!force && !shouldCompact(this.messages, this.contextTokens)) return null;
    const { messages, note } = await compact(this.messages, (p) => this.oneShot(p));
    this.messages = messages;
    this.#emitContext();
    if (note) return note;
    return force ? "Nothing to compact yet — the conversation is still short." : null;
  }

  async callModel() {
    // Try streaming for a live feel. Free `auto` routing hits many providers and
    // some return empty streams — if that happens, fall back to a reliable
    // non-streaming request.
    let streamed = null;
    try { streamed = await this.#requestModel(true); } catch { streamed = null; }
    if (streamed && ((streamed.content && streamed.content.trim()) || (streamed.tool_calls && streamed.tool_calls.length))) {
      return streamed;
    }
    return await this.#requestModel(false);
  }

  async #requestModel(stream) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: this.toolSchema(),
        tool_choice: "auto",
        temperature: 0.3,
        stream,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Gateway ${res.status}: ${body.slice(0, 500)}`);
    }
    const ctype = res.headers.get("content-type") || "";
    if (stream && ctype.includes("event-stream") && res.body) {
      return await this.#readStream(res.body);
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error("No choices returned from gateway");
    if (choice.message && choice.message.content) this.emit("assistant_delta", { chunk: choice.message.content });
    return choice.message;
  }

  // Parse an OpenAI-style SSE stream, emitting text deltas live and assembling
  // the final message (content + tool_calls).
  async #readStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    const toolCalls = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { try { reader.cancel(); } catch {} break; }
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) { content += delta.content; this.emit("assistant_delta", { chunk: delta.content }); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index || 0;
            toolCalls[i] = toolCalls[i] || { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function && tc.function.name) toolCalls[i].function.name = tc.function.name;
            if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
    }
    const calls = toolCalls.filter(Boolean);
    return { role: "assistant", content: content || "", tool_calls: calls.length ? calls : undefined };
  }

  // Build a diff preview for the approval prompt (file writes/edits).
  #approvalPreview(name, args) {
    const fs = require("node:fs");
    const path = require("node:path");
    try {
      if (name === "edit_file") return { kind: "diff", path: args.path, old: args.old_string || "", new: args.new_string || "" };
      if (name === "write_file") {
        const abs = path.resolve(this.workspace, args.path || "");
        const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
        return { kind: "diff", path: args.path, old: cur || "", new: args.content || "", created: cur === null };
      }
    } catch {}
    return null;
  }

  // Fan out to parallel subagents and return the combined summaries.
  async runSubagents(tasks) {
    const list = Array.isArray(tasks) ? tasks.slice(0, 8) : [];
    if (!list.length) return "No subtasks provided.";
    const groupId = "g" + Date.now().toString(36);
    this.emit("subagent", { groupId, kind: "group_start", count: list.length, titles: list.map((t) => t.title || "subagent") });

    const results = await Promise.all(
      list.map(async (t, i) => {
        const subId = `${groupId}_${i}`;
        const title = t.title || `subagent ${i + 1}`;
        this.emit("subagent", { groupId, subId, title, kind: "start" });
        const child = new Agent({
          baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model,
          workspace: this.workspace, mcp: this.mcp, browser: this.browser, canSpawn: false, depth: this.depth + 1,
          emit: (type, payload) => {
            if (type === "tool_call") this.emit("subagent", { groupId, subId, kind: "tool", tool: subLabel(payload.name, payload.args) });
            else if (type === "assistant") this.emit("subagent", { groupId, subId, kind: "text", snippet: String(payload.content || "").slice(0, 160) });
            else if (type === "error") this.emit("subagent", { groupId, subId, kind: "error", message: payload.message });
          },
        });
        try { await child.send(t.prompt || t.task || title); }
        catch (e) { this.emit("subagent", { groupId, subId, kind: "error", message: e.message }); }
        this.emit("subagent", { groupId, subId, kind: "done" });
        return { title, result: child.lastText || "(no summary returned)" };
      })
    );

    this.emit("subagent", { groupId, kind: "group_done" });
    return results.map((r) => `## ${r.title}\n${r.result}`).join("\n\n---\n\n");
  }

  async send(userText, images) {
    this.aborted = false;
    this.turnUndo = new Map();
    this.undoAvailable = false;
    // Refresh the system prompt with current project instructions (AGENTS.md, etc.).
    const mem = this.loadProjectMemory();
    this.messages[0] = {
      role: "system",
      content: this.baseSystem
        + (mem ? `\n\n# Project instructions (from the workspace)\n${mem}` : "")
        + (this.approvalMode === "plan" ? PLAN_MODE_PROMPT : ""),
    };
    // Multimodal: attach pasted images (vision) as an OpenAI content array.
    if (images && images.length) {
      this.messages.push({ role: "user", content: [{ type: "text", text: userText }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] });
    } else {
      this.messages.push({ role: "user", content: userText });
    }

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.aborted) { this.emit("aborted", {}); return; }
      // Auto-compact before the call would overflow; a failed summary degrades
      // to truncation inside compact(), never a crashed turn.
      try {
        const note = await this.compactNow();
        if (note) this.emit("system", { content: "⛁ " + note });
      } catch {}
      this.#emitContext();
      this.emit("thinking", { step });

      let msg;
      try { msg = await this.callModel(); }
      catch (err) { this.emit("error", { message: err.message }); return; }

      if (msg.content && msg.content.trim()) {
        this.lastText = msg.content;
        this.emit("assistant", { content: msg.content });
      }

      const toolCalls = msg.tool_calls || [];
      this.messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls.length ? toolCalls : undefined });

      if (!toolCalls.length) { this.emit("done", {}); return; }

      for (const call of toolCalls) {
        if (this.aborted) { this.emit("aborted", {}); return; }
        const name = call.function.name;
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(call.function.arguments || "{}"); } catch { parsedArgs = {}; }
        this.emit("tool_call", { id: call.id, name, args: parsedArgs });

        // Approval gate (top-level agents only): mode decides per tool.
        const decision = approvalDecision(this.approvalMode, name, !!(this.mcp && this.mcp.isMcpTool(name)));
        if (decision === "block") {
          const blocked = "⏸ Plan mode — changes are disabled. Present your plan instead; the user can switch modes to execute it.";
          this.emit("tool_result", { id: call.id, name, result: blocked });
          this.messages.push({ role: "tool", tool_call_id: call.id, content: blocked });
          continue;
        }
        if (decision === "ask" && this.approver) {
          const preview = this.#approvalPreview(name, parsedArgs);
          const ok = await this.approver(call.id, name, parsedArgs, preview);
          if (!ok) {
            const denied = "❌ Denied by user.";
            this.emit("tool_result", { id: call.id, name, result: denied });
            this.messages.push({ role: "tool", tool_call_id: call.id, content: denied });
            continue;
          }
        }

        let result;
        if (name === "spawn_subagents" && this.canSpawn) {
          result = await this.runSubagents(parsedArgs.tasks);
        } else if (name === "web_search" && this.browser) {
          try { result = await this.browser.search(parsedArgs.query); }
          catch (e) { result = "Search failed: " + e.message; }
        } else if (name === "browse_page" && this.browser) {
          try { result = await this.browser.open(parsedArgs.url); }
          catch (e) { result = "Browse failed: " + e.message; }
        } else if (name === "install_skills" && this.skillsDir) {
          try {
            const installed = await skills.installSkills(this.skillsDir, parsedArgs.source);
            result = installed.length
              ? `Installed skills: ${installed.join(", ")}. They are available right now — load one with use_skill.`
              : "No SKILL.md directories found at that source.";
          } catch (e) { result = "Install failed: " + e.message; }
        } else if (name === "use_skill" && this.skillsDir) {
          result = skills.readSkill(this.skillsDir, this.workspace, parsedArgs.name || "");
        } else if (name === "save_skill" && this.skillsDir) {
          try {
            const made = skills.createSkill(this.skillsDir, parsedArgs.name, parsedArgs.description, parsedArgs.instructions);
            result = `Saved skill "${made.name}" — available in every project via /` + made.name;
          } catch (e) { result = "Failed to save skill: " + e.message; }
        } else if (name === "save_memory" && this.memory) {
          const dir = parsedArgs.scope === "global" ? this.memory.globalDir : this.memory.projectDir;
          try { result = saveMemory(dir, parsedArgs.title || "note", parsedArgs.content || ""); }
          catch (e) { result = "Failed to save memory: " + e.message; }
        } else if (this.mcp && this.mcp.isMcpTool(name)) {
          result = await this.mcp.callTool(name, parsedArgs);
        } else {
          result = await executeTool(name, parsedArgs, {
            workspace: this.workspace,
            onChunk: (chunk) => this.emit("tool_stream", { id: call.id, chunk }),
            recordUndo: (rel, original) => {
              if (!this.turnUndo.has(rel)) { this.turnUndo.set(rel, original); this.undoAvailable = true; }
            },
          });
        }

        this.emit("tool_result", { id: call.id, name, result });
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    this.emit("error", { message: `Reached max steps (${MAX_STEPS}) without finishing.` });
  }
}

module.exports = { Agent, approvalDecision };
