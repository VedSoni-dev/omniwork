"use strict";
// Local model servers. The regressions: detection probed fixed ports and
// ignored OLLAMA_HOST; a server that wasn't usable was reported as just "not
// running" — on one machine Ollama was crash-looping once a second because
// its models folder linked to an unplugged drive, saying so only in a 519 MB
// log; and nothing said that Ollama's default 4,096-token context silently
// cuts longer prompts.
//
// Run: node test/local.js
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.OMNIWORK_OPENCODE_BIN = path.join(__dirname, "fixtures", "fake-opencode.js");
const providers = require("../electron/providers");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

(async () => {
  const OLLAMA = providers.LOCAL.find((l) => l.id === "ollama-local");

  // ── where the servers are ──
  for (const [v, want] of [["", "http://127.0.0.1:11434/v1"], ["127.0.0.1:11500", "http://127.0.0.1:11500/v1"], ["0.0.0.0", "http://127.0.0.1:11434/v1"], ["myhost", "http://myhost:11434/v1"], ["http://myhost", "http://myhost/v1"], ["https://ollama.internal/", "https://ollama.internal/v1"]]) {
    check(`OLLAMA_HOST=${JSON.stringify(v)} → ${want}`, providers.localUrl(OLLAMA, { OLLAMA_HOST: v }) === want);
  }
  check("LMSTUDIO_HOST moves LM Studio", providers.localCandidates({ LMSTUDIO_HOST: "127.0.0.1:4321" }).find((l) => l.id === "lm-studio").url === "http://127.0.0.1:4321/v1");

  // ── a fake Ollama at OLLAMA_HOST, a fake gateway to report to ──
  const ollama = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"data":[{"id":"qwen3.5:9b"}]}'); });
  const oport = await listen(ollama);
  const gw = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(req.url.startsWith("/api/providers") ? '{"connections":[]}' : '{"data":[{"id":"auto"}]}'); });
  const gport = await listen(gw);
  const g = { baseUrl: `http://127.0.0.1:${gport}/v1`, apiKey: "k" };
  process.env.OLLAMA_HOST = `127.0.0.1:${oport}`;
  const st = await providers.status(g);
  const entry = st.local.find((l) => l.id === "ollama-local");
  check("status() finds Ollama at OLLAMA_HOST", entry.running && entry.url === `http://127.0.0.1:${oport}/v1` && entry.runningModels.includes("qwen3.5:9b"));
  check("…and warns about Ollama's default context", /OLLAMA_CONTEXT_LENGTH/.test(providers.describe(st)));
  ollama.close();

  // ── why a server isn't usable ──
  const closed = await freePort();
  const none = await providers.diagnoseLocal({ ...OLLAMA, url: `http://127.0.0.1:${closed}/v1` }, { home: os.tmpdir(), env: {} });
  check("nothing listening is told apart…", !none.running && !none.listening && /nothing is listening/.test(none.reason));
  const broken = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  const bport = await listen(broken);
  const sick = await providers.diagnoseLocal({ ...OLLAMA, url: `http://127.0.0.1:${bport}/v1` }, { home: os.tmpdir(), env: {} });
  check("…from listening but erroring", !sick.running && sick.listening && /HTTP 500/.test(sick.reason));
  broken.close();
  const hang = net.createServer(() => {});
  const hport = await listen(hang);
  const stuck = await providers.diagnoseLocal({ ...OLLAMA, url: `http://127.0.0.1:${hport}/v1` }, { home: os.tmpdir(), env: {}, timeoutMs: 400 });
  check("…and from accepting but never answering", stuck.listening && /didn't answer/.test(stuck.reason));
  hang.close();

  // The machine that started this: a models folder linked to an unplugged drive.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-local-home-"));
  fs.mkdirSync(path.join(home, ".ollama", "logs"), { recursive: true });
  fs.symlinkSync("/Volumes/UnpluggedDrive/ollama/models", path.join(home, ".ollama", "models"));
  fs.writeFileSync(path.join(home, ".ollama", "logs", "server.log"), [
    'time=2026-10-14T10:00:00 level=INFO source=routes.go msg="starting"',
    `Error: mkdir ${home}/.ollama/models: file exists: ensure path elements are traversable`,
  ].join("\n").repeat(3) + "\n");
  const hints = providers.ollamaHints({ home, env: {}, bigLogBytes: 100 });
  check("a models folder linked to a missing drive is named, with the fix", hints.some((h) => /models folder ~\/\.ollama\/models links to \/Volumes\/UnpluggedDrive/.test(h) && /drive connected/.test(h)));
  check("the server log's last errors are quoted", hints.some((h) => /ensure path elements are traversable/.test(h)));
  check("a runaway log reads as crash-looping", hints.some((h) => /crash-looping/.test(h)));
  check("OLLAMA_MODELS is honoured", providers.ollamaHints({ home, env: { OLLAMA_MODELS: path.join(home, "nowhere") }, bigLogBytes: 1e12 }).every((h) => !/links to/.test(h)));

  const realHome = process.env.HOME;
  process.env.HOME = home;
  process.env.OLLAMA_HOST = `127.0.0.1:${closed}`;
  const st2 = await providers.status(g);
  const described = providers.describe(st2);
  check("status explains an unusable Ollama instead of 'not running'", /Ollama isn't usable: nothing is listening/.test(described) && /UnpluggedDrive/.test(described));
  const conn = await providers.connectLocal(g, { only: "ollama-local" });
  check("connect local says why it skipped Ollama", conn.skipped.length === 1 && conn.skipped[0].hints.some((h) => /UnpluggedDrive/.test(h)));
  const { complete } = require("../electron/complete");
  const r = await complete({ user: "hi", model: "ollama/qwen3.5:9b", timeoutMs: 2000 });
  check("a completion on a down Ollama carries the same diagnosis", !r.ok && /UnpluggedDrive/.test(r.error));
  process.env.HOME = realHome;
  delete process.env.OLLAMA_HOST;

  // ── local first, when asked ──
  const ids = ["openrouter/cohere/north-mini-code:free", "ollama/qwen3.5:9b", "groq/openai/gpt-oss-120b"];
  check("the chain ends with local servers by default", providers.suggestChain(ids).slice(-1)[0] === "ollama/qwen3.5:9b");
  check("OMNIWORK_PREFER_LOCAL puts them first", providers.suggestChain(ids, { preferLocal: true })[0] === "ollama/qwen3.5:9b");
  const gw2 = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: ["auto", ...ids].map((id) => ({ id })) })); });
  const g2port = await listen(gw2);
  process.env.OMNIWORK_PREFER_LOCAL = "1";
  delete process.env.OMNIWORK_MODEL;
  delete process.env.OMNIWORK_MODEL_FALLBACKS;
  const headless = require("../electron/headless");
  headless.invalidateModels();
  const resolved = await headless.resolveModelsLive({ baseUrl: `http://127.0.0.1:${g2port}/v1`, apiKey: "k" }, {});
  check("…and make a local model the primary for `auto`, cloud behind it", resolved.model === "ollama/qwen3.5:9b" && resolved.fallbackModels[resolved.fallbackModels.length - 1] === "auto");
  headless.invalidateModels();
  const pinned = await headless.resolveModelsLive({ baseUrl: `http://127.0.0.1:${g2port}/v1`, apiKey: "k" }, { model: "groq/openai/gpt-oss-120b" });
  check("…but never override a model someone chose", pinned.model === "groq/openai/gpt-oss-120b");
  delete process.env.OMNIWORK_PREFER_LOCAL;
  gw2.close();
  gw.close();

  fs.rmSync(home, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ LOCAL SERVERS TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
