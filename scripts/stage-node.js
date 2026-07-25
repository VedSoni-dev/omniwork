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

  // We can only stage a binary for the architecture we're running on. Building a
  // different arch (e.g. `--mac --x64` from an Apple Silicon machine) would ship
  // an unrunnable Node and the gateway would die on first launch — so say so
  // loudly rather than producing a broken installer.
  // electron-builder's Arch enum, mapped without pulling in builder-util.
  const ARCH = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
  const targetArch = ARCH[context.arch];
  if (targetArch && targetArch !== "universal" && targetArch !== process.arch) {
    console.warn(
      `[stage-node] ⚠ building for ${targetArch} on a ${process.arch} host. The staged Node ` +
      `binary is ${process.arch} and will NOT run on the target. Build ${targetArch} artifacts ` +
      `on a ${targetArch} machine (or in CI) instead.`
    );
  }

  fs.copyFileSync(src, dest);
  if (!isWin) fs.chmodSync(dest, 0o755);

  console.log(`[stage-node] bundled Node runtime (${process.arch}): ${src} -> ${dest}`);
};
