"use strict";
// Minimal, dependency-free MCP (Model Context Protocol) client.
// Speaks JSON-RPC 2.0 over a stdio transport (newline-delimited JSON), which is
// what `mcpServers` entries (Claude Desktop / Cursor / Codex style) expose.
// Lets OmniWork "plug into stuff": filesystem, git, web, databases, Slack, etc.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PROTOCOL_VERSION = "2024-11-05";

class MCPServer {
  constructor(name, conf) {
    this.name = name;
    this.conf = conf;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.tools = [];
    this.status = "idle";
    this.error = null;
  }

  async start() {
    this.status = "starting";
    const isWin = process.platform === "win32";
    // On Windows, npx/npm are .cmd shims — spawn through the shell.
    const cmd = this.conf.command;
    const args = this.conf.args || [];
    this.proc = spawn(cmd, args, {
      env: { ...process.env, ...(this.conf.env || {}) },
      cwd: this.conf.cwd || undefined,
      shell: isWin,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this.#onData(d));
    this.proc.stderr.on("data", () => {}); // servers log to stderr; ignore
    this.proc.on("error", (e) => { this.status = "error"; this.error = e.message; });
    this.proc.on("exit", (code) => {
      if (this.status !== "stopped") { this.status = "error"; this.error = this.error || `exited (${code})`; }
    });

    try {
      // Generous timeout: first run may cold-download the server via npx/uvx.
      await this.#request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "OmniWork", version: "0.2.0" },
      }, 90000);
      this.#notify("notifications/initialized", {});
      const res = await this.#request("tools/list", {}, 30000);
      this.tools = (res && res.tools) || [];
      this.status = "connected";
    } catch (e) {
      this.status = "error";
      this.error = e.message;
      this.stop();
    }
    return this.status;
  }

  #onData(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || "MCP error"));
        else resolve(msg.result);
      }
    }
  }

  #send(obj) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
  #notify(method, params) { this.#send({ jsonrpc: "2.0", method, params }); }
  #request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async callTool(toolName, args) {
    const res = await this.#request("tools/call", { name: toolName, arguments: args || {} }, 120000);
    const content = (res && res.content) || [];
    const text = content
      .map((c) => (c.type === "text" ? c.text : c.type === "resource" ? JSON.stringify(c.resource) : `[${c.type}]`))
      .join("\n");
    return res && res.isError ? `Error: ${text}` : text || "(no output)";
  }

  stop() {
    this.status = "stopped";
    if (this.proc && !this.proc.killed) { try { this.proc.kill(); } catch {} }
    this.proc = null;
  }
}

class MCPManager {
  constructor(dataDir) {
    this.configPath = path.join(dataDir, "mcp.json");
    this.servers = new Map(); // name -> MCPServer
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const j = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
        return j.mcpServers || {};
      }
    } catch {}
    return {};
  }

  saveConfig(mcpServers) {
    fs.writeFileSync(this.configPath, JSON.stringify({ mcpServers }, null, 2));
  }

  // Start every configured server (best-effort, parallel).
  async startAll() {
    const conf = this.loadConfig();
    await Promise.all(
      Object.entries(conf).map(async ([name, c]) => {
        const s = new MCPServer(name, c);
        this.servers.set(name, s);
        try { await s.start(); } catch {}
      })
    );
    return this.list();
  }

  async addServer(name, conf) {
    const all = this.loadConfig();
    all[name] = conf;
    this.saveConfig(all);
    const existing = this.servers.get(name);
    if (existing) existing.stop();
    const s = new MCPServer(name, conf);
    this.servers.set(name, s);
    await s.start();
    return this.list();
  }

  removeServer(name) {
    const all = this.loadConfig();
    delete all[name];
    this.saveConfig(all);
    const s = this.servers.get(name);
    if (s) s.stop();
    this.servers.delete(name);
    return this.list();
  }

  list() {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      status: s.status,
      error: s.error,
      tools: s.tools.map((t) => t.name),
    }));
  }

  // OpenAI-format tool schema for all connected MCP tools, namespaced by server.
  toolSchema() {
    const out = [];
    for (const s of this.servers.values()) {
      if (s.status !== "connected") continue;
      for (const t of s.tools) {
        out.push({
          type: "function",
          function: {
            name: `mcp__${s.name}__${t.name}`,
            description: `[${s.name}] ${t.description || t.name}`,
            parameters: t.inputSchema || { type: "object", properties: {} },
          },
        });
      }
    }
    return out;
  }

  isMcpTool(name) { return typeof name === "string" && name.startsWith("mcp__"); }

  async callTool(name, args) {
    // Robust split: server name is between the leading mcp__ and the first __<tool>.
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    const serverName = rest.slice(0, sep);
    const toolName = rest.slice(sep + 2);
    const s = this.servers.get(serverName);
    if (!s || s.status !== "connected") return `MCP server "${serverName}" not connected.`;
    try { return await s.callTool(toolName, args); }
    catch (e) { return `MCP call failed: ${e.message}`; }
  }

  stopAll() { for (const s of this.servers.values()) s.stop(); this.servers.clear(); }
}

module.exports = { MCPManager, MCPServer };
