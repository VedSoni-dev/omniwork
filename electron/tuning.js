"use strict";
// Routing and request policy. Tool output is paged locally with retrievable raw
// text; lossy gateway compression is an explicit opt-in.

const crypto = require("node:crypto");

const AUTO = "auto";
const FAST = "auto/best-fast";     // free "fast" routing combo — grunt work
const STRONG = "auto/best-coding"; // free "coding" routing combo — real reasoning

const off = (v) => /^(0|off|false|no)$/i.test(String(v ?? ""));

// Compression policy is sent per request; gateway settings are not mutated.
const compressionOn = () => /^(rtk|on|true|1)$/i.test(String(process.env.OMNIWORK_COMPRESSION || ""));
const requestHeaders = () => ({ "x-omniroute-compression": compressionOn() ? "rtk" : "off" });

// The richest payload we're confident the strict settings schema accepts,
// then a proven-minimal fallback so a schema drift never leaves compression off.
const COMPRESSION_RICH = {
  enabled: true, defaultMode: "rtk",
  engines: { rtk: { enabled: true, level: "standard" } },
  rtkConfig: {
    intensity: "standard",
    applyToToolResults: true,   // tool output is the bulk of an agent's context
    applyToCodeBlocks: false,
    rawOutputRetention: "always", // retained by upstream; OmniWork pages raw output locally
    deduplicateThreshold: 3,    // collapse blocks that repeat 3+ times
    enableGrouping: false,       // preserve individual search matches
    stripCodeComments: false,    // comments can carry requirements
    preserveDocstrings: true,   // …but docstrings often carry the contract
  },
  preserveSystemPromptMode: "whenNoCache", mcpDescriptionCompressionEnabled: true,
};
const COMPRESSION_MIN = { enabled: true, defaultMode: "rtk", preserveSystemPromptMode: "whenNoCache" };

function originOf(baseUrl) { return String(baseUrl).replace(/\/v1\/?$/, ""); }

async function enableCompression(baseUrl, apiKey, log = () => {}) {
  if (!compressionOn()) { log("compression: disabled by env"); return false; }
  const url = originOf(baseUrl) + "/api/settings/compression";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey || "omniwork"}` };
  for (const body of [COMPRESSION_RICH, COMPRESSION_MIN]) {
    try {
      const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      if (res.ok) { log(`compression on (rtk, ${body === COMPRESSION_RICH ? "standard" : "default"})`); return true; }
      log(`compression PUT ${res.status} — ${body === COMPRESSION_RICH ? "retrying minimal" : "gave up"}`);
    } catch (e) { log("compression enable failed: " + e.message); return false; }
  }
  return false;
}

// ── 2: the cheap model for housekeeping ──
function utilityModel(primary) {
  if (process.env.OMNIWORK_UTILITY_MODEL) return process.env.OMNIWORK_UTILITY_MODEL;
  // Only ever redirect the auto pools; a pinned model's owner may have reasons
  // (a keyed provider, a local server) we shouldn't second-guess, and an engine
  // model's oneShot is already local and cheap.
  return primary === AUTO || primary === FAST || primary === STRONG ? FAST : primary;
}

// ── 3: step-level tiers, on for `auto`, off for a pinned model ──
function tiersFor(primary, opt) {
  if (opt === false || off(process.env.OMNIWORK_MODEL_TIERS)) return null;
  if (primary !== AUTO) return null; // respect an explicit choice
  return { fast: FAST, strong: STRONG };
}

// A tool result that means the step failed — the signal to escalate.
function toolFailed(result) {
  const s = String(result || "");
  if (/^(Error in |old_string not found|Unknown tool:|Failed to |Failed to start|Search failed|Browse failed|Install failed|❌|⏸)/.test(s)) return true;
  // A non-zero exit code, wherever it lands (head+tail truncation keeps the tail).
  if (/\[exit code ([1-9]\d*)\]/.test(s)) return true;
  // Shell error lines, anchored so the words don't false-positive inside output.
  // A real shell error ends with the phrase; prose that merely mentions it keeps going.
  return /(^|\n)[^\n]*: (No such file or directory|command not found|Permission denied)(\n|$)/.test(s)
    || /\bENOENT\b/.test(s);
}

// Verifying a delegation costs a (cheap) model call, so only spend it when the
// task actually changed something or its wording implies it should have. A
// read-only research delegation is self-evident from its summary.
function shouldVerify(task, changed) {
  if (changed) return true;
  return /\b(create|write|edit|modify|fix|add|implement|refactor|rename|delete|remove|update|install|generate|build|migrat)/i.test(String(task || ""));
}

const newSessionId = () => crypto.randomUUID();

module.exports = { AUTO, FAST, STRONG, compressionOn, requestHeaders, enableCompression, utilityModel, tiersFor, toolFailed, shouldVerify, newSessionId };
