"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process");
const { git } = require("../electron/job-workspace");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-daemon-"));
const repo = path.join(root, "repo"); fs.mkdirSync(repo);
process.env.OMNIWORK_DATA_DIR = path.join(root, "data");
process.env.OMNIWORK_OPENCODE_BIN = path.join(__dirname, "fixtures", "fake-opencode.js");
process.env.OMNIWORK_JOB_RPM = "60000";
process.env.OMNIWORK_NO_PREWARM = "1";
const client = require("../electron/job-client");
const procs = []; let server, checks = 0;
const check = (name, fn) => { fn(); checks++; console.log("✓", name); };
function rpcClient() {
  const proc = spawn(process.execPath, [path.join(__dirname, "../electron/mcp-server.js")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(proc); proc.stderr.resume(); let buf = "", seq = 0; const pending = new Map();
  proc.stdout.on("data", chunk => { buf += chunk; let n; while ((n = buf.indexOf("\n")) >= 0) { const line = buf.slice(0,n); buf = buf.slice(n+1); const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  return { proc, call: (name, args) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => reject(new Error(`MCP timeout: ${name}`)), 35000);
    pending.set(id, result => { clearTimeout(timer); if (result.result?.isError) reject(new Error(result.result.content[0].text)); else resolve(result.result.structuredContent); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  }) };
}
(async () => {
  await git(repo, ["init", "-q"]); await git(repo, ["config", "user.email", "test@localhost"]); await git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base"); await git(repo, ["add", "."]); await git(repo, ["commit", "-qm", "fixture"]);
  let inflight = 0, peak = 0, requests = 0;
  server = http.createServer((req, res) => {
    let text = ""; req.on("data", d => text += d); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "fixture/free", cost: { input: 0, output: 0 }, supported_parameters: ["tools"], context_length: 32000 }] }));
      const body = JSON.parse(text); requests++; inflight++; peak = Math.max(peak, inflight);
      const task = body.messages.find(m => m.role === "user")?.content || "";
      const file = /^Create (\w+\.txt)/.exec(task)?.[1] || "output.txt";
      const message = body.messages.some(m => m.role === "tool") ? { role: "assistant", content: "Created and checked " + file } : { role: "assistant", content: "", tool_calls: [{ id: "write-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: file, content: "READY" }) } }] };
      setTimeout(() => { inflight--; res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 15, completion_tokens: 5 } })); }, 80);
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  process.env.OMNIWORK_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  const stale = path.join(client.location(), "service.lock"); fs.mkdirSync(stale, { recursive: true }); fs.writeFileSync(path.join(stale, "owner.json"), JSON.stringify({ pid: 2147483647 }));
  const a = rpcClient(), b = rpcClient();
  const task = i => ({ task: `Create file${i}.txt containing READY.`, allowed_paths: [`file${i}.txt`], checks: [`node -e 'if(require("fs").readFileSync("file${i}.txt","utf8")!=="READY")process.exit(1)'`] });
  const make = (id, numbers) => ({ cwd: repo, request_id: id, defaults: { model: "fixture/free", timeout_ms: 30000 }, tasks: numbers.map(task) });
  const firstStart = Date.now();
  const [one, two] = await Promise.all([a.call("jobs_submit", make("client-one", [1,2])), b.call("jobs_submit", make("client-two", [3,4]))]);
  const coldSubmitMs = Date.now() - firstStart;
  a.proc.kill();
  const ids = [...one.jobs, ...two.jobs].map(j => j.id);
  const pending = new Set(ids);
  while (pending.size) {
    const state = await b.call("jobs_wait", { ids: [...pending], timeout_ms: 25000 });
    for (const j of state.jobs) if (["completed", "failed", "cancelled", "partial", "interrupted"].includes(j.status)) { assert.equal(j.status, "completed", JSON.stringify(j)); pending.delete(j.id); }
  }
  check("two MCP clients share durable jobs that survive a client exit", () => { assert.equal(ids.length,4); assert(peak <= 2); assert.equal(requests,8); });
  const log = fs.readFileSync(path.join(client.location(), "service.log"), "utf8");
  check("simultaneous cold starts and stale-lock recovery launch one service", () => assert.equal((log.match(/Worker service ready/g)||[]).length,1));
  const repeated = await b.call("jobs_submit", make("client-one", [1,2]));
  check("reconnecting clients can retry a submission without duplicated execution", () => assert.deepEqual(repeated.jobs.map(j=>j.id),one.jobs.map(j=>j.id)));
  const read = await b.call("jobs_read", { id: ids[0], artifact: "patch" });
  check("MCP returns isolated artifacts while source remains unchanged", () => { assert(read.text.includes("file1.txt")); assert(!fs.existsSync(path.join(repo,"file1.txt"))); });
  const applied = await b.call("jobs_apply", { id: ids[0] });
  check("MCP verified application reaches the original working directory", () => { assert(applied.applied); assert.equal(fs.readFileSync(path.join(repo,"file1.txt"),"utf8"),"READY"); });
  const info = client.descriptor();
  const unauth = await fetch(`http://127.0.0.1:${info.port}/rpc`, { method:"POST", body:'{"method":"stats"}' });
  check("loopback API requires the private service token", () => assert.equal(unauth.status,401));
  const previousKey = process.env.OMNIWORK_API_KEY; process.env.OMNIWORK_API_KEY = "different-fixture";
  await assert.rejects(client.call("stats"), /different provider settings/);
  if (previousKey == null) delete process.env.OMNIWORK_API_KEY; else process.env.OMNIWORK_API_KEY = previousKey;
  check("clients cannot silently reuse a service with different provider credentials", () => assert(true));
  const previousEngineConfig = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ enabled_providers: ["fixture-only"] });
  await assert.rejects(client.call("stats"), /different provider settings/);
  if (previousEngineConfig == null) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = previousEngineConfig;
  check("clients cannot reuse a service with different engine configuration", () => assert(true));
  const before = Date.now();
  const queued = await b.call("jobs_submit", { cwd: repo, request_id: "warm-batch", defaults: { model: "missing/free" }, tasks: Array.from({length:100},(_,i)=>`Queued fixture ${i}`) });
  const warmSubmit100Ms = Date.now() - before;
  check("one warm call durably submits 100 tasks with no model work", () => { assert.equal(queued.jobs.length,100); assert.equal(requests,8); });
  await client.call("stop");
  await new Promise(r=>setTimeout(r,300));
  const restored = await b.call("jobs_get", { id: ids[0] });
  check("completed results survive a worker-service restart", () => { assert.equal(restored.status,"completed"); assert(restored.appliedAt); });
  console.log(JSON.stringify({ benchmark:"local fixture; not model latency",coldSubmitMs,warmSubmit100Ms,peakConcurrentInference:peak },null,2));
  console.log(`\n✅ JOB DAEMON TEST PASSED (${checks} checks)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  for(const p of procs)p.kill();
  await client.call("stop").catch(()=>{});await new Promise(r=>setTimeout(r,350));
  server?.closeAllConnections();server?.close();fs.rmSync(root,{recursive:true,force:true});
});
