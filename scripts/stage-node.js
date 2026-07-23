"use strict";
// electron-builder `beforePack` hook.
//
// OmniRoute's gateway is a Next.js standalone server that does NOT run correctly
// on Electron's embedded Node (worker/instrumentation incompatibilities). So we
// bundle a real Node binary next to the app and spawn the gateway with it.
//
// We copy the *build machine's* own Node binary. Our CI builds each OS on its
// native runner (win/mac/linux matrix), so each installer gets the right binary.
// Native modules (better-sqlite3) were compiled against this same Node during
// `npm install`, so the ABI matches; if it ever doesn't, OmniRoute falls back to
// its sql.js (WASM) store.

const fs = require("node:fs");
const path = require("node:path");

module.exports = async function stageNode(context) {
  const projectDir = context.packager.projectDir || process.cwd();
  const isWin = process.platform === "win32";
  const binName = isWin ? "node.exe" : "node";

  const outDir = path.join(projectDir, "build", "runtime");
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, binName);

  // process.execPath during electron-builder is the Node running the build.
  const src = process.execPath;
  fs.copyFileSync(src, dest);
  if (!isWin) fs.chmodSync(dest, 0o755);

  console.log(`[stage-node] bundled Node runtime: ${src} -> ${dest}`);
};
