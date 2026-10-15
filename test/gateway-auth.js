"use strict";
// Who can talk to the gateway. The regression: OmniRoute ran keyless (an
// invalid bearer fell back to anonymous), with no Host-header check, so any
// local process, any other account on the machine, and — by DNS rebinding — a
// web page could use every connected provider and the management API. The
// key OmniWork generated was never given to it.
//
// Now: the gateway is started with REQUIRE_API_KEY and the per-install key,
// a guard inside it rejects foreign Host and Origin headers, and the port and
// key are recorded owner-only so every OmniWork entry point uses them.
//
// A stand-in OmniRoute applies REQUIRE_API_KEY the way OmniRoute does; the
// real one is covered by test/boot.js.
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const mode = (f) => fs.statSync(f).mode & 0o777;
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// http.request, not fetch: fetch won't let a caller set Host.
function request(port, { path: p = "/v1/models", method = "GET", headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = ""; res.on("data", (d) => { body += d; }); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
}
function upgrade(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
    let data = ""; sock.on("data", (d) => { data += d; }); sock.on("close", () => resolve(data)); sock.on("error", () => resolve(data));
    setTimeout(() => { sock.destroy(); resolve(data); }, 2000);
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-gwauth-"));
  process.env.OMNIWORK_RUNTIME_DIR = path.join(root, "runtime");
  process.env.OMNIWORK_GATEWAY_PORT = String(await freePort());
  process.env.OMNIWORK_NODE = process.execPath;
  delete process.env.OMNIWORK_GATEWAY_OPEN;
  const port = Number(process.env.OMNIWORK_GATEWAY_PORT);
  const guard = path.join(__dirname, "..", "electron", "gateway-guard.js");

  // ── the guard, on its own ──
  {
    const server = path.join(root, "plain-server.js");
    fs.writeFileSync(server, `
const http = require("http");
const ok = (q, r) => { r.writeHead(200); r.end("served"); };
http.createServer(ok).listen(Number(process.env.PORT), "127.0.0.1");
http.createServer(ok).listen(Number(process.env.OTHER_PORT), "127.0.0.1");
`);
    const p = await freePort(), other = await freePort();
    const child = spawn(process.execPath, ["--require", guard, server], { env: { PATH: process.env.PATH, PORT: String(p), OTHER_PORT: String(other), OMNIWORK_GATEWAY_ALLOWED_HOSTS: "host.docker.internal" }, stdio: "ignore" });
    for (let i = 0; i < 50 && (await request(p)).status === 0; i++) await sleep(100);
    check("the gateway's own loopback Host is served", (await request(p)).status === 200);
    check("…and localhost", (await request(p, { headers: { Host: `localhost:${p}` } })).status === 200);
    const rebound = await request(p, { headers: { Host: `rebind.evil.example:${p}` } });
    check("a foreign Host (DNS rebinding) is refused", rebound.status === 403 && /OMNIWORK_GUARD/.test(rebound.body) && !/served/.test(rebound.body));
    check("a Host on another port is refused", (await request(p, { headers: { Host: `127.0.0.1:${p + 1}` } })).status === 403);
    check("a missing Host is refused", (await new Promise((r) => { const s = net.connect(p, "127.0.0.1", () => s.write("GET /v1/models HTTP/1.0\r\n\r\n")); let d = ""; s.on("data", (x) => { d += x; }); s.on("close", () => r(d)); })).startsWith("HTTP/1.1 403"));
    check("a cross-site Origin is refused", (await request(p, { method: "POST", headers: { Origin: "https://evil.example" } })).status === 403);
    check("Origin: null is refused", (await request(p, { headers: { Origin: "null" } })).status === 403);
    check("the dashboard's own Origin is served", (await request(p, { method: "POST", headers: { Origin: `http://127.0.0.1:${p}` } })).status === 200);
    check("OMNIWORK_GATEWAY_ALLOWED_HOSTS adds a Host", (await request(p, { headers: { Host: `host.docker.internal:${p}` } })).status === 200);
    check("servers on other ports in the process are untouched", (await request(other, { headers: { Host: "anything.example" } })).status === 200);
    const ws = await upgrade(p, `evil.example:${p}`);
    check("a WebSocket upgrade with a foreign Host is refused", ws.startsWith("HTTP/1.1 403") && !ws.includes("101"));
    child.kill();
  }

  // ── a gateway OmniWork starts requires its key ──
  const { Gateway, readGatewayState, findRunningGateway } = require("../electron/sidecar");
  const omniDir = path.join(root, "fake-omni");
  fs.mkdirSync(path.join(omniDir, "dist"), { recursive: true });
  // Applies REQUIRE_API_KEY + OMNIROUTE_API_KEY as OmniRoute's clientApi policy
  // does: with the flag, a missing or wrong key is a 401.
  fs.writeFileSync(path.join(omniDir, "dist", "server.js"), `
const fs = require("fs"), path = require("path");
fs.writeFileSync(path.join(__dirname, "env-" + process.pid + ".json"), JSON.stringify({ REQUIRE_API_KEY: process.env.REQUIRE_API_KEY, OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY }));
require("http").createServer((req, res) => {
  const sent = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (process.env.REQUIRE_API_KEY === "true" && sent !== process.env.OMNIROUTE_API_KEY) { res.writeHead(401); return res.end('{"error":{"code":"AUTH_002"}}'); }
  res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[{"id":"auto"}]}');
}).listen(Number(process.env.PORT), process.env.HOSTNAME);
`);
  const envOf = (gw) => JSON.parse(fs.readFileSync(path.join(omniDir, "dist", `env-${gw.proc.pid}.json`), "utf8"));
  const gw = new Gateway({ dataDir: path.join(root, "desktop"), omniDir, healthTimeoutMs: 10_000, onStatus: () => {} });
  await gw.start();
  const env = envOf(gw);
  check("the gateway is started with REQUIRE_API_KEY", env.REQUIRE_API_KEY === "true");
  check("…and OmniWork's per-install key", env.OMNIROUTE_API_KEY === gw.apiKey && /^ow-[0-9a-f]{48}$/.test(gw.apiKey));
  check("no key → 401", (await request(port)).status === 401);
  check("a wrong key → 401", (await request(port, { headers: { Authorization: "Bearer junk" } })).status === 401);
  check("the per-install key → 200", (await request(port, { headers: { Authorization: `Bearer ${gw.apiKey}` } })).status === 200);
  check("the guard is loaded into the gateway process", (await request(port, { headers: { Host: `evil.example:${port}`, Authorization: `Bearer ${gw.apiKey}` } })).status === 403);
  const keyFile = path.join(process.env.OMNIWORK_RUNTIME_DIR, "gateway-key.txt");
  const state = readGatewayState();
  check("the key file is owner-only", mode(keyFile) === 0o600 && fs.readFileSync(keyFile, "utf8").trim() === gw.apiKey);
  check("the gateway is recorded (port, key, pid), owner-only", state && state.port === port && state.key === gw.apiKey && state.pid === gw.proc.pid && mode(path.join(process.env.OMNIWORK_RUNTIME_DIR, "gateway.json")) === 0o600);
  check("the runtime dir is owner-only", mode(process.env.OMNIWORK_RUNTIME_DIR) === 0o700);

  // Another entry point adopts it with the key it accepts.
  const second = new Gateway({ dataDir: path.join(root, "headless"), omniDir, healthTimeoutMs: 10_000, onStatus: () => {} });
  await second.start();
  check("a second entry point adopts the running gateway", second.adopted && second.port === port && second.apiKey === gw.apiKey);
  second.stop();
  const headless = JSON.parse(execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "..", "electron", "headless.js"))}).ensureGateway().then((g) => { process.stdout.write(JSON.stringify(g)); process.exit(0); })`], { env: { ...process.env, OMNIWORK_DATA_DIR: path.join(root, "data") }, encoding: "utf8" }));
  check("headless servers reuse it with its key (not a placeholder)", headless.apiKey === gw.apiKey && headless.baseUrl === `http://127.0.0.1:${port}/v1`);

  // A rotated key file doesn't strand the running gateway: the state wins.
  fs.writeFileSync(keyFile, "ow-rotated");
  const found = await findRunningGateway();
  check("a replaced key file still finds the running gateway's key", found && found.apiKey === gw.apiKey);
  fs.writeFileSync(keyFile, gw.apiKey);

  gw.stop();
  await sleep(300);
  check("stopping the gateway clears its record", readGatewayState() === null);

  // ── a gateway that had to move off the well-known port is still found ──
  {
    const squatter = net.createServer(() => {}); // holds the port, never answers
    await new Promise((r) => squatter.listen(port, "127.0.0.1", r));
    const moved = new Gateway({ dataDir: path.join(root, "desktop"), omniDir, healthTimeoutMs: 10_000, patienceMs: 300, onStatus: () => {} });
    await moved.start();
    check("a blocked well-known port moves the gateway", moved.port !== port);
    const found2 = await findRunningGateway();
    check("…and other processes find it through the state file", found2 && found2.port === moved.port && found2.apiKey === moved.apiKey);
    moved.stop();
    squatter.close();
    await sleep(300);
  }

  // ── OMNIWORK_GATEWAY_OPEN keeps the old keyless gateway for a release ──
  {
    process.env.OMNIWORK_GATEWAY_OPEN = "1";
    const open = new Gateway({ dataDir: path.join(root, "desktop"), omniDir, healthTimeoutMs: 10_000, onStatus: () => {} });
    await open.start();
    check("OMNIWORK_GATEWAY_OPEN=1 starts it without REQUIRE_API_KEY", envOf(open).REQUIRE_API_KEY === "false" && (await request(open.port)).status === 200);
    check("…the guard still applies", (await request(open.port, { headers: { Host: `evil.example:${open.port}` } })).status === 403);
    open.stop();
    delete process.env.OMNIWORK_GATEWAY_OPEN;
    await sleep(300);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ GATEWAY AUTH TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
