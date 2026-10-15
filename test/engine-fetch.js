"use strict";
// The lite build's engine download. The regression: the OmniRoute tarball —
// code the gateway then runs with the user's privileges — was streamed from
// the registry straight into tar with no integrity check, against a floating
// ^3.8.x version. Now it is pinned (version and sha512, kept equal to
// package-lock.json here) and verified before anything is unpacked.
//
// Run: node test/engine-fetch.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const tar = require("tar");
const { downloadEngine, engineDir, engineReady, pinnedEngine } = require("../electron/engine-fetch");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

(async () => {
  const pkg = require("../package.json");
  const lock = require("../package-lock.json").packages["node_modules/omniroute"];
  const pin = pinnedEngine();
  check("omniroute is pinned to an exact version", /^\d+\.\d+\.\d+$/.test(pkg.dependencies.omniroute));
  check("the engine pin matches package-lock.json (version and sha512)", pin.version === lock.version && pin.integrity === lock.integrity && pkg.dependencies.omniroute === lock.version);

  // A tarball laid out like npm's, served locally.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-enginefetch-"));
  fs.mkdirSync(path.join(root, "src", "package", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "package", "dist", "server.js"), "// fake engine\n");
  fs.writeFileSync(path.join(root, "src", "package", "package.json"), '{"name":"omniroute","version":"9.9.9"}');
  fs.writeFileSync(path.join(root, "src", "package", "postinstall.sh"), "not extracted");
  const tgz = path.join(root, "omniroute.tgz");
  await tar.c({ gzip: true, file: tgz, cwd: path.join(root, "src") }, ["package"]);
  const bytes = fs.readFileSync(tgz);
  const good = "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(bytes); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/omniroute-9.9.9.tgz`;

  const okDir = path.join(root, "ok");
  await downloadEngine(okDir, null, { entry: { version: "9.9.9", integrity: good, url } });
  check("a tarball matching the pinned hash is installed", engineReady(engineDir(okDir)));
  check("…only the server's files are unpacked", !fs.existsSync(path.join(engineDir(okDir), "postinstall.sh")));
  check("…and the downloaded archive is cleaned up", !fs.readdirSync(path.dirname(engineDir(okDir))).some((f) => /\.tgz/.test(f)));

  const badDir = path.join(root, "bad");
  let error = null;
  try { await downloadEngine(badDir, null, { entry: { version: "9.9.9", integrity: "sha512-" + crypto.createHash("sha512").update("something else").digest("base64"), url } }); }
  catch (e) { error = e; }
  check("a tarball that doesn't match is refused", error && /integrity check/.test(error.message));
  check("…and nothing of it is unpacked", !engineReady(engineDir(badDir)) && !fs.readdirSync(path.dirname(engineDir(badDir))).some((f) => /\.tgz/.test(f)));
  let weak = null;
  try { await downloadEngine(path.join(root, "weak"), null, { entry: { version: "9.9.9", integrity: "md5-abc", url } }); } catch (e) { weak = e; }
  check("a weak or malformed hash is refused outright", weak && /unusable/.test(weak.message));

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ ENGINE FETCH TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
