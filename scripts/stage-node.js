"use strict";
// electron-builder `beforePack` hook.
//
// OmniRoute's gateway is a Next.js standalone server that does NOT run correctly
// on Electron's embedded Node (worker/instrumentation incompatibilities). So we
// bundle a real Node binary next to the app and spawn the gateway with it.
//
// We fetch the official build from nodejs.org rather than copying the build
// machine's `process.execPath`. Copying looks simpler but ships a broken app:
// package-manager Node binaries are dynamically linked against libraries that
// only exist on the build machine. Homebrew's node, for instance, needs
// @rpath/libnode.<abi>.dylib plus llhttp/libuv/ada/simdjson/brotli from
// /opt/homebrew — none of which are in the bundle, so the gateway dies at launch
// with "Library not loaded". Official builds are self-contained.
//
// Fetching by target arch also means cross-arch packaging works: building the
// x64 DMG on an Apple Silicon Mac gets a real x64 Node, not an arm64 one.
//
// The version tracks the build machine's Node so native modules
// (better-sqlite3) keep their ABI. Override with OMNIWORK_NODE_VERSION.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// electron-builder's Arch enum, mapped without pulling in builder-util.
const ARCH = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function nodePlatform(context) {
  const name = (context.platform && (context.platform.nodeName || context.platform.name)) || process.platform;
  if (name === "mac" || name === "darwin") return "darwin";
  if (name === "windows" || name === "win32") return "win32";
  return "linux";
}

// True if the binary only depends on libraries present on a stock system.
// A false result means the bundle would fail at runtime on someone else's
// machine, so callers treat it as fatal.
function isSelfContained(binary, platform) {
  if (platform !== "darwin") return true; // only checkable cheaply on macOS
  let out;
  try { out = execFileSync("otool", ["-L", binary], { encoding: "utf8" }); }
  catch { return true; } // no otool (non-mac host) — nothing to assert
  const deps = out.split("\n").slice(1).map((l) => l.trim().split(" ")[0]).filter(Boolean);
  const foreign = deps.filter((d) => !d.startsWith("/usr/lib/") && !d.startsWith("/System/"));
  return foreign.length === 0;
}

async function downloadOfficialNode(version, platform, arch, cacheDir) {
  const tag = platform === "win32" ? "win" : platform;
  const base = `node-v${version}-${tag}-${arch}`;
  const ext = platform === "win32" ? "zip" : "tar.gz";
  const url = `https://nodejs.org/dist/v${version}/${base}.${ext}`;

  fs.mkdirSync(cacheDir, { recursive: true });
  const extracted = path.join(cacheDir, base);
  const binInside = platform === "win32"
    ? path.join(extracted, "node.exe")
    : path.join(extracted, "bin", "node");
  if (fs.existsSync(binInside)) return binInside; // cached from an earlier build

  const archive = path.join(cacheDir, `${base}.${ext}`);
  if (!fs.existsSync(archive)) {
    console.log(`[stage-node] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive + ".part"));
    fs.renameSync(archive + ".part", archive);
  }

  if (ext === "zip") {
    execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${cacheDir}' -Force`], { stdio: "inherit" });
  } else {
    // `tar` is already a runtime dependency (see engine-fetch.js).
    await require("tar").x({ file: archive, cwd: cacheDir });
  }
  if (!fs.existsSync(binInside)) throw new Error(`extracted ${base} but ${binInside} is missing`);
  return binInside;
}

module.exports = async function stageNode(context) {
  const projectDir = context.packager.projectDir || process.cwd();
  const platform = nodePlatform(context);
  const isWin = platform === "win32";
  const binName = isWin ? "node.exe" : "node";

  // "universal" mac builds fold two arch builds together; stage the host's.
  let arch = ARCH[context.arch] || process.arch;
  if (arch === "universal") arch = process.arch;

  const outDir = path.join(projectDir, "build", "runtime");
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, binName);
  const version = process.env.OMNIWORK_NODE_VERSION || process.versions.node;

  let src;
  try {
    src = await downloadOfficialNode(version, platform, arch, path.join(projectDir, "build", ".node-cache"));
  } catch (err) {
    // Offline or an unpublished version. Copying the local Node is only safe if
    // it's self-contained AND we're not cross-building.
    console.warn(`[stage-node] could not fetch official Node v${version}: ${err.message}`);
    if (arch !== process.arch || platform !== process.platform) {
      throw new Error(
        `[stage-node] cannot stage a ${platform}-${arch} Node runtime on ` +
        `${process.platform}-${process.arch} without the official download. ` +
        `Restore network access, or build on a matching machine.`
      );
    }
    if (!isSelfContained(process.execPath, platform)) {
      throw new Error(
        `[stage-node] refusing to bundle ${process.execPath}: it is dynamically linked ` +
        `against libraries outside /usr/lib (e.g. a Homebrew libnode), so the gateway ` +
        `would fail to launch on any other machine. Install an official Node build from ` +
        `nodejs.org and rebuild, or restore network access so the official binary can be fetched.`
      );
    }
    console.warn(`[stage-node] falling back to the local Node binary`);
    src = process.execPath;
  }

  fs.copyFileSync(src, dest);
  if (!isWin) fs.chmodSync(dest, 0o755);

  // Last line of defence: never ship a runtime that can't resolve its libraries.
  if (!isSelfContained(dest, platform)) {
    throw new Error(`[stage-node] staged Node at ${dest} is not self-contained — aborting build.`);
  }

  console.log(`[stage-node] bundled Node v${version} (${platform}-${arch}): ${src} -> ${dest}`);
};
