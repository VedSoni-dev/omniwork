#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const client = require("../electron/job-client");
const { submission } = require("../electron/job-tools");
(async () => {
  const [command = "status", value] = process.argv.slice(2);
  let args = {}, method = command;
  if (command === "submit") {
    if (!value) throw new Error("Usage: omniwork-jobs submit <tasks.json|->");
    const input = JSON.parse(fs.readFileSync(value === "-" ? 0 : value, "utf8"));
    args = input.tasks ? submission(input) : { tasks: [input] };
  } else if (["get", "cancel", "apply"].includes(command)) { if (!value) throw new Error("A job ID is required"); args = { id: value }; }
  else if (command === "wait") { if (!value) throw new Error("Provide comma-separated job IDs"); args = { ids: value.split(","), timeout_ms: 25000 }; }
  else if (command === "status") method = "stats";
  else if (!["list", "stop", "refresh"].includes(command)) throw new Error("Commands: submit, get, wait, list, cancel, apply, status, refresh, stop");
  const result = await client.call(method, args, { timeout: method === "apply" ? 900000 : 30000 });
  console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
