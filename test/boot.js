"use strict";
// Lightweight CI check: the bundled gateway boots and serves its model list —
// and only to OmniWork: it requires the per-install key, and its guard refuses
// a foreign Host (DNS rebinding) or a cross-site Origin. Does not call an
// external model (that needs live free-provider availability; see
// test/smoke.js for the full end-to-end run).

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
  ];
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
