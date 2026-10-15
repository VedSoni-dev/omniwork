"use strict";
// What the gateway keeps on disk. The regression: OmniWork set no logging
// variables, so OmniRoute wrote every request's full prompt and reply to
// call_logs/<date>/*.json (one machine had 93), world-readable, kept a week;
// ACP transcripts were world-readable too.
//
// Now the per-install key is marked no-log (bodies are never written; the
// real OmniRoute is checked in test/boot.js), the gateway runs with umask 077,
// files written before that are tightened, and OMNIWORK_GATEWAY_LOGS=on is the
// visible way to keep bodies. A stand-in gateway reports its environment.
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const mode = (f) => fs.statSync(f).mode & 0o777;
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (process.platform === "win32") { console.log("- POSIX file modes; skipping on Windows"); process.exit(0); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-logging-"));
  process.env.OMNIWORK_RUNTIME_DIR = path.join(root, "runtime");
  process.env.OMNIWORK_NODE = process.execPath;
  delete process.env.OMNIWORK_GATEWAY_LOGS;
  const { Gateway } = require("../electron/sidecar");

  const omniDir = path.join(root, "fake-omni");
  fs.mkdirSync(path.join(omniDir, "dist"), { recursive: true });
  // Reports its environment, and writes a "call log" the way OmniRoute does —
  // no explicit mode, so the process umask decides.
  fs.writeFileSync(path.join(omniDir, "dist", "server.js"), `
const fs = require("fs"), path = require("path");
const dir = path.join(process.env.DATA_DIR, "call_logs", "today");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "call.json"), "{}");
fs.writeFileSync(path.join(__dirname, "env-" + process.pid + ".json"), JSON.stringify(process.env));
require("http").createServer((q, r) => { r.writeHead(200); r.end('{"data":[]}'); }).listen(Number(process.env.PORT), process.env.HOSTNAME);
`);
  const boot = async (dataDir) => {
    process.env.OMNIWORK_GATEWAY_PORT = String(await freePort());
    delete require.cache[require.resolve("../electron/sidecar")];
    const { Gateway: G } = require("../electron/sidecar");
    const statuses = [];
    const gw = new G({ dataDir, omniDir, healthTimeoutMs: 10_000, onStatus: (s) => statuses.push(s) });
    await gw.start();
    const env = JSON.parse(fs.readFileSync(path.join(omniDir, "dist", `env-${gw.proc.pid}.json`), "utf8"));
    return { gw, env, statuses };
  };

  // ── defaults ──
  {
    const dataDir = path.join(root, "a");
    const store = path.join(dataDir, "omniroute");
    // What an earlier version left behind, world-readable.
    fs.mkdirSync(path.join(store, "call_logs", "2026-10-14"), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(store, "call_logs", "2026-10-14", "old.json"), '{"requestBody":"old prompt"}', { mode: 0o644 });
    fs.mkdirSync(path.join(store, "db_backups"), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(store, "db_backups", "backup.sqlite"), "keys", { mode: 0o644 });
    const { gw, env } = await boot(dataDir);
    check("the per-install key is marked no-log, so prompt bodies are never written", env.NO_LOG_API_KEY_IDS === "env-key");
    check("the app log file is off and retention is a day", env.APP_LOG_TO_FILE === "false" && env.CALL_LOG_RETENTION_DAYS === "1");
    check("files the gateway writes are owner-only (umask 077)", mode(path.join(store, "call_logs", "today", "call.json")) === 0o600 && mode(path.join(store, "call_logs", "today")) === 0o700);
    check("call logs from before are tightened", mode(path.join(store, "call_logs", "2026-10-14", "old.json")) === 0o600 && mode(path.join(store, "call_logs", "2026-10-14")) === 0o700);
    check("…and database backups", mode(path.join(store, "db_backups", "backup.sqlite")) === 0o600);
    check("the gateway's data directory is owner-only", mode(store) === 0o700);
    gw.stop();
    await sleep(300);
  }

  // ── the visible toggle, and tuning by passthrough ──
  {
    process.env.OMNIWORK_GATEWAY_LOGS = "on";
    process.env.OMNIWORK_GATEWAY_ENV_PASSTHROUGH = "CALL_LOG_RETENTION_DAYS";
    process.env.CALL_LOG_RETENTION_DAYS = "3";
    const { gw, env } = await boot(path.join(root, "b"));
    check("OMNIWORK_GATEWAY_LOGS=on keeps request bodies", !("NO_LOG_API_KEY_IDS" in env));
    check("…still owner-only", mode(path.join(root, "b", "omniroute", "call_logs", "today", "call.json")) === 0o600);
    check("retention can be tuned through the passthrough", env.CALL_LOG_RETENTION_DAYS === "3");
    gw.stop();
    delete process.env.OMNIWORK_GATEWAY_LOGS;
    delete process.env.OMNIWORK_GATEWAY_ENV_PASSTHROUGH;
    delete process.env.CALL_LOG_RETENTION_DAYS;
    await sleep(300);
  }

  // ── adopting a gateway an older OmniWork started is not silent ──
  {
    const port = await freePort();
    const legacy = http.createServer((q, r) => { r.writeHead(200); r.end('{"data":[]}'); }); // keyless, no record
    await new Promise((r) => legacy.listen(port, "127.0.0.1", r));
    process.env.OMNIWORK_GATEWAY_PORT = String(port);
    delete require.cache[require.resolve("../electron/sidecar")];
    const { Gateway: G } = require("../electron/sidecar");
    const statuses = [];
    const gw = new G({ dataDir: path.join(root, "c"), omniDir, onStatus: (s) => statuses.push(s) });
    await gw.start();
    check("adopting an unrecorded (older) gateway warns that it may log prompts", gw.adopted && statuses.some((s) => /older OmniWork/.test(s.detail || "") && /log prompts/.test(s.detail || "")));
    gw.stop();
    legacy.close();
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ GATEWAY LOGGING TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
