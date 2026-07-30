// Smoke test: the MCP server speaks JSON-RPC over stdio, lists all six tools,
// and the electron-free tools (list_skills, static browse_page) work. No
// gateway boot — delegation tools are only listed, not called.
const { spawn } = require("child_process");
const path = require("path");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

// NO_PREWARM: initialize now boots the gateway in the background, which we don't
// want a unit test spawning a real OmniRoute server for.
const proc = spawn(process.execPath, [path.join(__dirname, "..", "electron", "mcp-server.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OMNIWORK_NO_PREWARM: "1" },
});
const pending = new Map();
let nextId = 1;
let buf = "";
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + " timed out")); } }, 20_000);
});

(async () => {
  const init = await rpc("initialize", {});
  check("initialize returns server info", init.result.serverInfo.name === "omniwork");

  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name).sort();
  check("all six tools listed", names.join(",") === "browse_page,delegate,delegate_parallel,install_skills,list_skills,web_search");
  check("delegate description teaches when NOT to use it", /DON'T use/.test(list.result.tools.find((t) => t.name === "delegate").description));
  check("browse_page discloses static fetch", /static fetch/.test(list.result.tools.find((t) => t.name === "browse_page").description));
  check("every tool has a when-to-use description", list.result.tools.every((t) => t.description.length > 80));

  const skills = await rpc("tools/call", { name: "list_skills", arguments: {} });
  check("list_skills answers", typeof skills.result.content[0].text === "string" && skills.result.content[0].text.length > 0);

  const bad = await rpc("tools/call", { name: "browse_page", arguments: { url: "file:///etc/passwd" } });
  check("browse_page rejects non-http", bad.result.isError === true || /only http/.test(bad.result.content[0].text));

  proc.kill();
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ MCP SERVER TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.message); proc.kill(); process.exit(1); });
