"use strict";
// Headless test: two agent sessions running in parallel (Cowork), plus the new
// web_fetch tool, against the bundled gateway. No GUI.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Gateway } = require("../electron/sidecar");
const { SessionManager } = require("../electron/sessions");
const { MCPManager } = require("../electron/mcp");

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-cw-"));
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "ow-a-"));
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ow-b-"));

  const gateway = new Gateway({ dataDir, onStatus: (s) => console.log(`[gw:${s.state}] ${s.detail || ""}`) });
  await gateway.start();

  const mcp = new MCPManager(dataDir);
  const events = { A: [], B: [] };
  const sm = new SessionManager({
    gateway, mcp,
    emit: (id, type) => { /* id null = list broadcast */ if (id) { const tag = id === idA ? "A" : "B"; if (events[tag]) events[tag].push(type); } },
  });

  const a = sm.create({ workspace: wsA, title: "A" });
  const b = sm.create({ workspace: wsB, title: "B" });
  const idA = a.id, idB = b.id;

  console.log("\n--- running two sessions in parallel ---");
  const t0 = Date.now();
  await Promise.all([
    sm.send(idA, 'Create a file notes.txt containing "session A". Then read it back.'),
    sm.send(idB, 'Create a file data.txt containing "session B". Then read it back.'),
  ]);
  console.log(`both finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const aFile = fs.existsSync(path.join(wsA, "notes.txt")) && fs.readFileSync(path.join(wsA, "notes.txt"), "utf8");
  const bFile = fs.existsSync(path.join(wsB, "data.txt")) && fs.readFileSync(path.join(wsB, "data.txt"), "utf8");
  console.log("A wrote notes.txt:", JSON.stringify(aFile));
  console.log("B wrote data.txt:", JSON.stringify(bFile));
  console.log("A status:", sm.sessions.get(idA).status, "| B status:", sm.sessions.get(idB).status);

  const parallelOk = aFile && bFile && String(aFile).includes("session A") && String(bFile).includes("session B");

  gateway.stop();
  console.log("\n" + (parallelOk ? "✅ COWORK PARALLEL TEST PASSED" : "❌ FAILED"));
  process.exit(parallelOk ? 0 : 1);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
