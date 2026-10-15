"use strict";
// The keyless pools. The regression: with nothing connected, every `auto/*`
// request went to OmniRoute's keyless "OpenCode Free" provider, which reaches
// OpenCode Zen by impersonating the OpenCode client (on by default) and which
// upstream now refuses ("only from within OpenCode") — so every request was a
// 502 wall of upstream errors.
//
// Now the header synthesis is off, the keyless provider is blocked once per
// gateway store (free Zen models run through the real OpenCode binary), and
// a pool failure says why — or, with nothing to route to, says to connect a
// provider. A stand-in OmniRoute implements /api/settings; test/boot.js checks
// the real one.
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-keyless-"));
  process.env.OMNIWORK_RUNTIME_DIR = path.join(root, "runtime");
  process.env.OMNIWORK_NODE = process.execPath;
  delete process.env.OMNIWORK_KEYLESS_OPENCODE;
  const omniDir = path.join(root, "fake-omni");
  fs.mkdirSync(path.join(omniDir, "dist"), { recursive: true });
  // Settings live in DATA_DIR/settings.json; every PATCH is logged.
  fs.writeFileSync(path.join(omniDir, "dist", "server.js"), `
const fs = require("fs"), path = require("path");
const file = path.join(process.env.DATA_DIR, "settings.json");
const log = path.join(process.env.DATA_DIR, "patches.log");
fs.writeFileSync(path.join(process.env.DATA_DIR, "env.json"), JSON.stringify(process.env));
const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
require("http").createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/settings" && req.method === "PATCH") { const next = { ...read(), ...JSON.parse(b) }; fs.writeFileSync(file, JSON.stringify(next)); fs.appendFileSync(log, b + "\\n"); return res.end(JSON.stringify(next)); }
    if (req.url === "/api/settings") return res.end(JSON.stringify(read()));
    res.end('{"data":[]}');
  });
}).listen(Number(process.env.PORT), process.env.HOSTNAME);
`);
  const boot = async (dataDir) => {
    process.env.OMNIWORK_GATEWAY_PORT = String(await freePort());
    delete require.cache[require.resolve("../electron/sidecar")];
    const { Gateway } = require("../electron/sidecar");
    const statuses = [];
    const gw = new Gateway({ dataDir, omniDir, healthTimeoutMs: 10_000, onStatus: (s) => statuses.push(s) });
    await gw.start();
    return { gw, statuses };
  };
  const store = (name) => path.join(root, name, "omniroute");
  const patches = (name) => { try { return fs.readFileSync(path.join(store(name), "patches.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  {
    fs.mkdirSync(store("a"), { recursive: true });
    fs.writeFileSync(path.join(store("a"), "settings.json"), JSON.stringify({ blockedProviders: ["felo-web"] }));
    const { gw } = await boot(path.join(root, "a"));
    const env = JSON.parse(fs.readFileSync(path.join(store("a"), "env.json"), "utf8"));
    check("the gateway no longer impersonates the OpenCode client", env.OPENCODE_SYNTHESIZE_CLI_HEADERS === "false");
    const p = patches("a");
    check("keyless OpenCode is blocked, keeping the user's own blocks", p.length === 1 && JSON.stringify(p[0].blockedProviders) === '["felo-web","opencode"]');
    gw.stop(); await sleep(300);

    // The user re-enables it in the dashboard: that choice stands.
    fs.writeFileSync(path.join(store("a"), "settings.json"), JSON.stringify({ blockedProviders: [] }));
    const again = await boot(path.join(root, "a"));
    check("a user who re-enables it is not overridden on the next start", patches("a").length === 1);
    again.gw.stop(); await sleep(300);
  }
  {
    process.env.OMNIWORK_KEYLESS_OPENCODE = "on";
    const { gw } = await boot(path.join(root, "b"));
    check("OMNIWORK_KEYLESS_OPENCODE=on leaves the provider alone", patches("b").length === 0);
    gw.stop(); delete process.env.OMNIWORK_KEYLESS_OPENCODE; await sleep(300);
  }

  // ── what a failed pool tells the user ──
  const { Agent } = require("../electron/agent");
  const chat = (status, body, headers = {}) => new Promise((r) => {
    const s = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); }); });
    s.listen(0, "127.0.0.1", () => r({ baseUrl: `http://127.0.0.1:${s.address().port}/v1`, close: () => s.close() }));
  });
  const errorOf = async (gw, model) => {
    let message = "";
    const agent = new Agent({ baseUrl: gw.baseUrl, apiKey: "k", model, workspace: root, canSpawn: false, streaming: false, tiers: false, emit: (t, p) => { if (t === "error") message = p.message; } });
    await agent.send("hi");
    return message;
  };
  {
    const gw = await chat(404, { error: { message: "Combo has no executable targets", code: "model_not_found" } });
    const msg = await errorOf(gw, "auto/best-chat");
    check("an auto pool with nothing to route to says to connect a provider", /no connected model provider can serve auto\/best-chat/.test(msg) && /npm run providers connect local/.test(msg));
    gw.close();
  }
  {
    const gw = await chat(502, { error: { message: "All combo targets failed" }, diagnostics: { poolSize: 3, attempted: 3, excluded: [{ provider: "oc", model: "mimo-v2.5-free", reason: "deprecated" }, { provider: "oc", model: "muse", reason: "needs key" }, { provider: "oc", model: "x", reason: "needs key" }], terminalReason: "all_models_failed" } });
    const msg = await errorOf(gw, "auto/best-chat");
    check("a failed pool's diagnostics reach the user", /pool of 3; 3 tried; 1 deprecated, 2 needs key/.test(msg));
    gw.close();
  }
  {
    const gw = await chat(502, { error: { message: "upstream failed" } }, { "x-omniroute-combo-pool-size": "2", "x-omniroute-combo-attempted": "2", "x-omniroute-combo-excluded": "oc/a:exhausted" });
    check("…from the x-omniroute-combo-* headers too", /pool of 2; 2 tried; 1 exhausted/.test(await errorOf(gw, "auto/best-chat")));
    gw.close();
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ KEYLESS POOL TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
