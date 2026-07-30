// Smoke test: the ACP server speaks Agent Client Protocol v1 over stdio —
// initialize/session/new/set_mode/load/prompt, session updates as notifications,
// and clean JSON-RPC errors for bad input.
//
// OMNIWORK_BASE_URL points the agent at a dead port so no gateway boots: session
// setup still works, and session/prompt fails fast, which is exactly how we
// check that a broken turn surfaces as a JSON-RPC error instead of hanging.
const { spawn } = require("child_process");
const path = require("path");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

const proc = spawn(process.execPath, [path.join(__dirname, "..", "electron", "acp-server.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OMNIWORK_NO_PREWARM: "1", OMNIWORK_BASE_URL: "http://127.0.0.1:9/v1" },
});

const pending = new Map();
const notes = [];          // every notification the server pushed at us
let nextId = 1;
let buf = "";
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && m.method === undefined) {
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } else if (m.method) notes.push(m);
  }
});

const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + " timed out")); } }, 25_000);
});
const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const settle = () => new Promise((r) => setTimeout(r, 150));
const updates = (type) => notes.filter((n) => n.method === "session/update" && n.params.update.sessionUpdate === type);

(async () => {
  const repo = path.join(__dirname, "..");

  // ── initialize ──
  const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
  check("initialize returns protocol v1", init.result.protocolVersion === 1);
  check("initialize identifies the agent", init.result.agentInfo.name === "omniwork");
  check("advertises loadSession", init.result.agentCapabilities.loadSession === true);
  check("advertises image prompts", init.result.agentCapabilities.promptCapabilities.image === true);

  // ── session/new ──
  const made = await rpc("session/new", { cwd: repo, mcpServers: [] });
  const sid = made.result.sessionId;
  check("session/new returns a sessionId", typeof sid === "string" && sid.length > 0);
  check("session/new advertises four modes", made.result.modes.availableModes.length === 4);
  check("session/new defaults to ask mode", made.result.modes.currentModeId === "ask");

  const relative = await rpc("session/new", { cwd: "not/absolute", mcpServers: [] });
  check("session/new rejects a relative cwd", relative.error && relative.error.code === -32602);

  await settle();
  check("skills are pushed as available commands", updates("available_commands_update").length === 1);

  // ── modes ──
  const mode = await rpc("session/set_mode", { sessionId: sid, modeId: "plan" });
  check("session/set_mode succeeds", !mode.error);
  await settle();
  const modeNotes = updates("current_mode_update");
  check("set_mode notifies current_mode_update", modeNotes.length === 1 && modeNotes[0].params.update.currentModeId === "plan");

  const badMode = await rpc("session/set_mode", { sessionId: sid, modeId: "nonsense" });
  check("session/set_mode rejects an unknown mode", badMode.error && badMode.error.code === -32602);

  // ── load ──
  const loaded = await rpc("session/load", { sessionId: sid, cwd: repo, mcpServers: [] });
  check("session/load restores a live session", !loaded.error && loaded.result.modes.currentModeId === "plan");
  const missing = await rpc("session/load", { sessionId: "sess_nope", cwd: repo, mcpServers: [] });
  check("session/load rejects an unknown session", missing.error && missing.error.code === -32602);

  // ── prompt ──
  const orphan = await rpc("session/prompt", { sessionId: "sess_nope", prompt: [{ type: "text", text: "hi" }] });
  check("session/prompt rejects an unknown session", orphan.error && orphan.error.code === -32602);

  const empty = await rpc("session/prompt", { sessionId: sid, prompt: [] });
  check("an empty prompt ends the turn cleanly", empty.result && empty.result.stopReason === "end_turn");

  // Real turn against a dead gateway: must come back as an error, not a hang.
  const broken = await rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "say hello" }] });
  check("a failed turn surfaces as a JSON-RPC error", Boolean(broken.error) && /connection|fetch|engine/i.test(broken.error.message));

  // ── cancel is a notification: must not produce a response or crash ──
  notify("session/cancel", { sessionId: sid });
  await settle();
  check("session/cancel is accepted silently", proc.exitCode === null);

  // ── unknown method ──
  const unknown = await rpc("session/telepathy", {});
  check("unknown methods return -32601", unknown.error && unknown.error.code === -32601);

  proc.kill();
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ ACP SERVER TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.message); proc.kill(); process.exit(1); });
