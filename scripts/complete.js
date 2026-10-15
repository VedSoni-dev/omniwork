#!/usr/bin/env node
"use strict";
// One tool-free completion from the terminal — the same path as the ACP
// `completion` mode and the MCP `complete` tool (electron/complete.js): no
// tools in the request, the system prompt verbatim, nothing written to disk.
//
//   npm run complete -- --model ollama/qwen3.5:9b --system-file s.txt --schema s.json < input.txt
//
// Prints the reply — the parsed JSON, pretty-printed, when --schema is given.
// --json prints the whole result (model, usage, truncated, attempts). Exits 1
// when no model produced an answer (or, with --schema, a valid one).

const fs = require("node:fs");
const { complete } = require("../electron/complete");

const USAGE = `usage: npm run complete -- [options] < input.txt

  --model <id>          model (default: OMNIWORK_MODEL, else auto);
                        ollama/<name> runs on the local Ollama server directly
  --fallback <a,b,...>  models to try, in order, if it fails (never any others)
  --system <text>       system prompt, used verbatim
  --system-file <path>  …or read it from a file
  --schema <path>       JSON Schema the reply must match (validated; one retry)
  --input <path>        read the content from a file instead of stdin
  --temperature <n>     default 0.2
  --max-tokens <n>      default 4096
  --timeout-ms <n>      per model attempt, default 120000
  --num-ctx <n>         Ollama context length (default: sized to the prompt)
  --json                print the full result as JSON`;

const VALUE = new Set(["--model", "--fallback", "--system", "--system-file", "--schema", "--input", "--temperature", "--max-tokens", "--timeout-ms", "--num-ctx"]);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (VALUE.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown option: ${a}`);
  }
  return o;
}

function number(o, key) {
  if (o[key] == null) return undefined;
  const n = Number(o[key]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} must be a number`);
  return n;
}

async function readStdin() {
  if (process.stdin.isTTY) throw new Error("no input: pipe the content in, or pass --input <path>");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(USAGE); return 0; }
  if (o.system != null && o["system-file"] != null) throw new Error("use --system or --system-file, not both");
  const system = o["system-file"] != null ? fs.readFileSync(o["system-file"], "utf8") : (o.system ?? "");
  let schema = null;
  if (o.schema != null) {
    try { schema = JSON.parse(fs.readFileSync(o.schema, "utf8")); } catch (e) { throw new Error(`--schema: ${e.message}`); }
  }
  const user = o.input != null ? fs.readFileSync(o.input, "utf8") : await readStdin();
  const settings = { temperature: number(o, "temperature"), maxTokens: number(o, "max-tokens"), timeoutMs: number(o, "timeout-ms"), numCtx: number(o, "num-ctx") };
  for (const k of Object.keys(settings)) if (settings[k] === undefined) delete settings[k];

  const r = await complete({
    system, user, schema,
    model: o.model || process.env.OMNIWORK_MODEL || "auto",
    fallbackModels: o.fallback ? o.fallback.split(",").map((s) => s.trim()).filter(Boolean) : [],
    ...settings,
    // Only models that need the gateway start it.
    gateway: () => require("../electron/headless").ensureGateway((...a) => process.stderr.write(`[gateway] ${a.join(" ")}\n`)),
  });

  if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  else if (r.ok) process.stdout.write((r.parsed !== undefined ? JSON.stringify(r.parsed, null, 2) : r.text) + "\n");
  if (r.truncated) process.stderr.write("warning: the prompt was cut to fit the model's context — raise --num-ctx or use a model with a longer context\n");
  if (!r.ok) {
    process.stderr.write(`error: ${r.error}\n${r.attempts.map((a) => `  ${a.model} (${a.transport}): ${a.error || "ok"}`).join("\n")}\n`);
    return 1;
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => { process.stderr.write(`error: ${e.message}\n\n${USAGE}\n`); process.exitCode = 2; })
  // A gateway this run started outlives it by design; don't wait on its timers.
  .finally(() => setTimeout(() => process.exit(), 50).unref());
