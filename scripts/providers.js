#!/usr/bin/env node
"use strict";
// Connect free model providers to OmniWork's gateway from the terminal.
//
//   npm run providers                      status: what's connected, the fallback chain, local servers
//   npm run providers connect openrouter   one click in the browser — no key to paste
//   npm run providers connect groq <key>   paste a key (created at the URL status shows)
//   npm run providers connect local        register Ollama / LM Studio / llama.cpp / vLLM if running
//   npm run providers connect opencode     download OpenCode (~45 MB, no npm/PATH) — Zen's free models as an engine, no account
//   npm run providers remove <provider>
//
// Same module the desktop panel, the MCP `connect_provider` tool, and the ACP
// auth methods use — one path, whichever harness is asking.

const { ensureGateway, invalidateModels, providers } = require("../electron/headless");

const log = (...a) => process.stderr.write(a.join(" ") + "\n");

async function main(argv) {
  const [cmd, provider, key] = argv;
  const gw = await ensureGateway((...a) => log("[gateway]", ...a));

  if (!cmd || cmd === "status") {
    console.log(providers.describe(await providers.status(gw)));
    console.log("\nConnect one:  npm run providers connect openrouter   (browser, no key)\n              npm run providers connect <provider> <api-key>\n              npm run providers connect local");
    return 0;
  }
  if (cmd === "connect") {
    if (!provider) { console.error("usage: providers connect <openrouter|local|ollama-cloud|kilo-gateway|groq|cerebras|nvidia|gemini|mistral> [api-key]"); return 2; }
    const result = await providers.connect(gw, provider, {
      apiKey: key,
      install: true, // a typed command is the explicit gesture the OpenCode download needs
      log: (line) => process.stderr.write("[opencode] " + line + "\n"),
      onUrl: (url) => console.log(`Opening your browser to connect OpenRouter. If it didn't open, visit:\n  ${url}\n`),
    });
    invalidateModels();
    if (result.engine) {
      console.log(`OpenCode engine ready (${result.version || "installed"}) — ${result.models} free models: ${result.modelIds.join(", ")}`);
    } else if (result.added) {
      console.log(result.added.length
        ? `Registered: ${result.added.map((a) => `${a.name} (${a.models.length} models)`).join(", ")}`
        : `No local model server is running (checked ${result.skipped.map((s) => s.name).join(", ")}).`);
    } else {
      console.log(`Connected ${result.name} — ${result.models} models now routable.`);
    }
    console.log(`Fallback chain: ${result.chain && result.chain.length ? result.chain.join(" → ") : "(empty)"}`);
    return 0;
  }
  if (cmd === "remove") {
    if (!provider) { console.error("usage: providers remove <provider>"); return 2; }
    const n = await providers.removeProvider(gw, provider);
    invalidateModels();
    console.log(n ? `Removed ${n} connection(s) for ${provider}.` : `Nothing connected for ${provider}.`);
    return 0;
  }
  console.error(`unknown command: ${cmd}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
