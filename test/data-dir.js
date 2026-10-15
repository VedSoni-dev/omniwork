"use strict";
// One gateway store. The regression: the desktop app kept its gateway store
// in its app-data dir and headless servers (MCP, ACP, CLI, jobs) in
// ~/.omniwork, so a provider connected in the app was missing whenever a
// headless server had started the gateway. Headless servers now use the app's
// data dir; an old headless store is copied over once, never deleted.
//
// Run: node test/data-dir.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.OMNIWORK_OPENCODE_BIN = path.join(__dirname, "fixtures", "fake-opencode.js");
const { adoptLegacyStore } = require("../electron/headless");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-datadir-"));
const legacy = path.join(root, "home", ".omniwork", "omniroute");
const shared = path.join(root, "app-data", "omniroute");
fs.mkdirSync(legacy, { recursive: true });
fs.writeFileSync(path.join(legacy, "storage.sqlite"), "connections");
fs.writeFileSync(path.join(legacy, "storage.sqlite-wal"), "wal");

const msg = adoptLegacyStore(legacy, shared);
check("an old headless store is copied into the shared one", /copied/.test(msg || "") && fs.readFileSync(path.join(shared, "storage.sqlite"), "utf8") === "connections" && fs.existsSync(path.join(shared, "storage.sqlite-wal")));
check("…owner-only", process.platform === "win32" || (fs.statSync(path.join(shared, "storage.sqlite")).mode & 0o777) === 0o600);
check("…and the original is kept, with a note", fs.existsSync(path.join(legacy, "storage.sqlite")) && /no longer uses this copy/.test(fs.readFileSync(path.join(legacy, "MOVED.txt"), "utf8")));

fs.writeFileSync(path.join(legacy, "storage.sqlite"), "newer headless connections");
const again = adoptLegacyStore(legacy, shared);
check("an existing shared store is never overwritten", /another gateway store exists/.test(again || "") && fs.readFileSync(path.join(shared, "storage.sqlite"), "utf8") === "connections");
check("nothing to move → nothing said", adoptLegacyStore(path.join(root, "nowhere"), shared) === null);
check("the same directory is left alone", adoptLegacyStore(shared, shared) === null);

fs.rmSync(root, { recursive: true, force: true });
console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ DATA DIR TEST PASSED");
process.exit(fails ? 1 : 0);
