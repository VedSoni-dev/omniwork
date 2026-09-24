"use strict";
const fs = require("node:fs");
const TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket|network/i;
const transient = e => ["TimeoutError", "AbortError"].includes(e?.name) || TRANSIENT.test(e?.message || "");
async function readWithRetry(call, method, args, { attempts = 4, pause = ms => new Promise(r => setTimeout(r, ms)), onRetry = () => {} } = {}) {
  if (!["wait", "get", "list", "read", "stats"].includes(method)) throw new Error("Only read operations may be retried");
  for (let n = 1; ; n++) {
    try { return await call(method, args, { timeout: 60000 }); }
    catch (error) {
      if (!transient(error) || n >= attempts) throw error;
      onRetry({ method, attempt: n, error: error.message });
      await pause(Math.min(1000, n * 250));
    }
  }
}
function writeJSON(file, value) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
function summarize(rows, profiles) {
  const median = values => {
    const s = values.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : null;
  };
  return Object.fromEntries(profiles.map(profile => {
    const jobs = rows.filter(r => r.profile === profile);
    const accepted = jobs.filter(r => r.accepted).length;
    const total = key => jobs.reduce((n, j) => n + (j.result?.usage?.[key] || 0), 0);
    const totalInput = total("inTokens");
    return [profile, { jobs: jobs.length, attempted: jobs.filter(j => j.result).length,
      accepted, usageAvailable: jobs.filter(j => j.result?.usage?.available).length,
      totalInput, uncachedInput: total("uncachedInTokens"), cacheRead: total("cacheReadTokens"),
      cacheWrite: total("cacheWriteTokens"), output: total("outTokens"), modelRequests: total("modelRequests"),
      repairs: jobs.reduce((n, j) => n + (j.result?.attempts?.filter(a => a.phase === "repair").length || 0), 0),
      inputPerAccepted: accepted ? totalInput / accepted : null,
      medianExecutionMs: median(jobs.map(j => j.result?.elapsedMs)) }];
  }));
}
module.exports = { transient, readWithRetry, writeJSON, summarize };
