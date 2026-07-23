"use strict";
// Lightweight CI check: the bundled gateway boots and serves its model list.
// Does not call an external model (that needs live free-provider availability;
// see test/smoke.js for the full end-to-end run).

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Gateway } = require("../electron/sidecar");

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-ci-"));
  const gateway = new Gateway({
    dataDir,
    onStatus: (s) => console.log(`[gateway:${s.state}] ${s.detail || ""}`),
  });
  await gateway.start();

  const res = await fetch(`${gateway.baseUrl}/models`);
  const data = await res.json();
  const count = (data.data || []).length;
  console.log(`/v1/models -> HTTP ${res.status}, ${count} models`);

  gateway.stop();
  const pass = res.ok && count > 0;
  console.log(pass ? "✅ BOOT CHECK PASSED" : "❌ BOOT CHECK FAILED");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("boot check crashed:", e);
  process.exit(1);
});
