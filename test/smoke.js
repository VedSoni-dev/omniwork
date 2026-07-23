"use strict";
// End-to-end smoke test WITHOUT the Electron GUI:
//   1. boot the bundled OmniRoute gateway (via system node, like a packaged build)
//   2. run the real Agent loop against it with a task that must use tools
//   3. assert the gateway responded and the file tool actually wrote to disk
//
// Run: node test/smoke.js

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { Gateway } = require("../electron/sidecar");
const { Agent } = require("../electron/agent");

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-ws-"));
  console.log("data dir:", dataDir);
  console.log("workspace:", workspace);

  const gateway = new Gateway({
    dataDir,
    onStatus: (s) => console.log(`[gateway:${s.state}] ${s.detail || ""}`),
  });

  console.log("\n--- starting gateway ---");
  const t0 = Date.now();
  await gateway.start();
  console.log(`gateway ready in ${((Date.now() - t0) / 1000).toFixed(1)}s @ ${gateway.baseUrl}`);

  const events = [];
  const agent = new Agent({
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
    model: "auto",
    workspace,
    emit: (type, payload) => {
      events.push({ type, ...payload });
      if (type === "assistant") console.log("\n[assistant]", payload.content.slice(0, 300));
      else if (type === "tool_call") console.log(`[tool_call] ${payload.name}(${JSON.stringify(payload.args).slice(0, 120)})`);
      else if (type === "tool_result") console.log(`[tool_result] ${payload.name}: ${String(payload.result).slice(0, 120)}`);
      else if (type === "error") console.log("[error]", payload.message);
    },
  });

  console.log("\n--- sending task ---");
  await agent.send(
    'Create a file named hello.txt containing exactly the text "Hello from OmniWork". Then read it back to confirm.'
  );

  // Assertions
  const target = path.join(workspace, "hello.txt");
  const wrote = fs.existsSync(target);
  const content = wrote ? fs.readFileSync(target, "utf8") : "";
  const usedTool = events.some((e) => e.type === "tool_call");
  const hadError = events.some((e) => e.type === "error");

  console.log("\n===== RESULT =====");
  console.log("used a tool:      ", usedTool);
  console.log("hello.txt exists: ", wrote);
  console.log("content:          ", JSON.stringify(content));
  console.log("had error:        ", hadError);

  gateway.stop();

  const pass = usedTool && wrote && content.includes("Hello from OmniWork") && !hadError;
  console.log("\n" + (pass ? "✅ SMOKE TEST PASSED" : "❌ SMOKE TEST FAILED"));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
