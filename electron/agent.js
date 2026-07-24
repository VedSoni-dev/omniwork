"use strict";
// The agent loop. Talks to the local OmniRoute gateway (OpenAI-compatible /v1)
// and runs a tool-use loop until the model produces a final answer.

const { TOOL_SCHEMA, executeTool } = require("./tools");

const SYSTEM_PROMPT = `You are OmniWork, an autonomous coding agent running on the user's machine, in the style of Claude Code.
You have direct access to the user's workspace through tools: list_dir, read_file, write_file, edit_file, run_command.

Guidelines:
- Be concise and direct. Do the work; don't just describe it.
- Explore before editing: read files to understand context before changing them.
- Make focused, correct edits. Prefer edit_file for surgical changes, write_file for new files.
- Use run_command for builds, tests, git, installing deps, and searching (grep/rg).
- After changes, verify by running the relevant build/test/command when possible.
- When the task is complete, give a short summary of what you did.`;

const MAX_STEPS = 40;

class Agent {
  constructor({ baseUrl, apiKey, model, workspace, emit, mcp }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model || "auto";
    this.workspace = workspace;
    this.emit = emit; // (event, payload) => void
    this.mcp = mcp || null; // optional MCPManager for external tools
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.aborted = false;
  }

  toolSchema() {
    const extra = this.mcp ? this.mcp.toolSchema() : [];
    return [...TOOL_SCHEMA, ...extra];
  }

  abort() {
    this.aborted = true;
  }

  setWorkspace(dir) {
    this.workspace = dir;
  }

  async callModel() {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: this.toolSchema(),
        tool_choice: "auto",
        temperature: 0.3,
        stream: false, // gateway defaults to SSE; force a single JSON body
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Gateway ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error("No choices returned from gateway");
    return choice.message;
  }

  // Run one user turn to completion (through any number of tool calls).
  async send(userText) {
    this.aborted = false;
    this.messages.push({ role: "user", content: userText });

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.aborted) {
        this.emit("aborted", {});
        return;
      }
      this.emit("thinking", { step });

      let msg;
      try {
        msg = await this.callModel();
      } catch (err) {
        this.emit("error", { message: err.message });
        return;
      }

      // Assistant text (if any)
      if (msg.content && msg.content.trim()) {
        this.emit("assistant", { content: msg.content });
      }

      const toolCalls = msg.tool_calls || [];
      // Persist assistant message exactly as returned so tool_call_ids line up.
      this.messages.push({
        role: "assistant",
        content: msg.content || "",
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });

      if (!toolCalls.length) {
        this.emit("done", {});
        return;
      }

      for (const call of toolCalls) {
        if (this.aborted) {
          this.emit("aborted", {});
          return;
        }
        const name = call.function.name;
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          parsedArgs = {};
        }
        this.emit("tool_call", { id: call.id, name, args: parsedArgs });

        let result;
        if (this.mcp && this.mcp.isMcpTool(name)) {
          result = await this.mcp.callTool(name, parsedArgs);
        } else {
          result = await executeTool(name, parsedArgs, {
            workspace: this.workspace,
            onChunk: (chunk) => this.emit("tool_stream", { id: call.id, chunk }),
          });
        }

        this.emit("tool_result", { id: call.id, name, result });
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
    }
    this.emit("error", { message: `Reached max steps (${MAX_STEPS}) without finishing.` });
  }
}

module.exports = { Agent };
