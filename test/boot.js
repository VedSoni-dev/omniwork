"use strict";
// Lightweight CI check: the bundled gateway boots and serves its model list —
// and only to OmniWork: it requires the per-install key, its guard refuses a
// foreign Host (DNS rebinding) or a cross-site Origin, and prompts it routes
// leave no body in its call logs. Does not call an external model (that needs
// live free-provider availability; see test/smoke.js for the full end-to-end
// run) — a local stand-in plays the upstream provider.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

// http.request, not fetch: fetch won't let a caller set Host.
function request(port, { path: p = "/v1/models", method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", (e) => resolve({ status: 0, text: e.message }));
    req.end(body);
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-ci-"));
  // Keep the key and the running-gateway record out of the real ~/.omniwork.
  process.env.OMNIWORK_RUNTIME_DIR = path.join(dataDir, "runtime");
  const { Gateway } = require("../electron/sidecar");
  const gateway = new Gateway({
    dataDir,
    onStatus: (s) => console.log(`[gateway:${s.state}] ${s.detail || ""}`),
  });
  await gateway.start();
  const port = gateway.port;
  const key = { Authorization: `Bearer ${gateway.apiKey}` };

  const res = await fetch(`${gateway.baseUrl}/models`, { headers: key });
  const data = await res.json();
  const count = (data.data || []).length;
  console.log(`/v1/models -> HTTP ${res.status}, ${count} models`);

  const checks = [
    ["/v1/models without the key is refused", (await request(port)).status === 401],
    ["/v1/models with a wrong key is refused", (await request(port, { headers: { Authorization: "Bearer junk" } })).status === 401],
    ["chat completions without the key are refused", (await request(port, { path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }) })).status === 401],
    ["a foreign Host is refused (DNS rebinding)", (await request(port, { headers: { ...key, Host: `rebind.evil.example:${port}` } })).status === 403],
    ["a cross-site Origin is refused", (await request(port, { headers: { ...key, Origin: "https://evil.example" } })).status === 403],
    ["the management API refuses a foreign Host", (await request(port, { path: "/api/providers", headers: { Host: `rebind.evil.example:${port}` } })).status === 403],
    ["keyless OpenCode (client impersonation) is blocked", ((await (await fetch(`${gateway.baseUrl.replace(/\/v1$/, "")}/api/settings`, { headers: key })).json()).blockedProviders || []).includes("opencode")],
    ["…so no keyless oc/ model is routable", !(data.data || []).some((m) => /^oc\//.test(m.id))],
  ];
  // A prompt that really goes upstream — to a local stand-in registered as the
  // Ollama provider — must not leave its body in call_logs.
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.includes("/models")) return res.end(JSON.stringify({ data: [{ id: "fixture", object: "model" }] }));
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const providers = require("../electron/providers");
  await providers.connectLocal(gateway, { candidates: [{ id: "ollama-local", alias: "ollama", name: "Ollama", url: `http://127.0.0.1:${upstream.address().port}/v1` }] });
  const marker = "PROMPT-BODY-MARKER-" + Date.now();
  const sent = await fetch(`${gateway.baseUrl}/chat/completions`, { method: "POST", headers: { ...key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "ollama/fixture", messages: [{ role: "user", content: marker }] }) });
  await new Promise((r) => setTimeout(r, 3000)); // call logs are written by a worker
  const store = path.join(dataDir, "omniroute");
  const files = fs.readdirSync(store, { recursive: true }).map((f) => path.join(store, f)).filter((f) => fs.statSync(f).isFile());
  checks.push(["a prompt routed upstream reaches the provider", sent.ok]);
  checks.push(["…and its body is not written to disk", !files.some((f) => /call_logs/.test(f) && fs.readFileSync(f, "utf8").includes(marker))]);
  if (process.platform !== "win32") checks.push(["everything the gateway wrote is owner-only", files.every((f) => (fs.statSync(f).mode & 0o077) === 0)]);
  upstream.close();

  for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);

  gateway.stop();
  const pass = res.ok && count > 0 && checks.every(([, ok]) => ok);
  console.log(pass ? "✅ BOOT CHECK PASSED" : "❌ BOOT CHECK FAILED");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("boot check crashed:", e);
  process.exit(1);
});
