"use strict";
// Lite build: OmniRoute is NOT bundled in the installer. On first run we download
// the omniroute npm tarball and extract just its prebuilt server (dist/) into the
// app data dir. Subsequent launches reuse it. Full builds skip this entirely.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// What to fetch, and the hash it must have: package.json's `omniworkEngine`,
// copied from package-lock.json (test/engine-fetch.js keeps the two in sync).
// package-lock.json itself doesn't ship with the app; package.json does. The
// engine is code the gateway runs with the user's privileges, so a download
// that doesn't match is never unpacked.
function pinnedEngine() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const pin = pkg.omniworkEngine && pkg.omniworkEngine.omniroute;
  if (!pin || !pin.version || !pin.integrity) throw new Error("package.json has no pinned engine (omniworkEngine.omniroute) — refusing to download one unverified");
  return { version: pin.version, integrity: pin.integrity, url: `https://registry.npmjs.org/omniroute/-/omniroute-${pin.version}.tgz` };
}

function engineDir(dataDir) { return path.join(dataDir, "engine", "omniroute"); }

// True if a usable engine is already present (bundled or previously downloaded).
function engineReady(dir) {
  return fs.existsSync(path.join(dir, "dist", "server.js"));
}

// Download + verify + extract omniroute's dist/ into <dataDir>/engine/omniroute.
// `entry` ({ version, integrity, url }) is for tests.
async function downloadEngine(dataDir, onProgress, { entry = null } = {}) {
  const tar = require("tar"); // small, battle-tested; bundled in both builds
  const { version: ver, integrity, url } = entry || pinnedEngine();
  const [algo, expected] = String(integrity).split("-", 2);
  if (!/^sha(256|384|512)$/.test(algo) || !expected) throw new Error("unusable engine integrity string");
  const dir = engineDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });

  onProgress && onProgress({ phase: "download", detail: `Fetching engine v${ver}…` });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`engine download failed: HTTP ${res.status}`);

  // To a file first, hashing as it arrives: nothing is unpacked until the
  // whole archive matches the pinned hash.
  const archive = path.join(path.dirname(dir), `omniroute-${ver}.tgz.part`);
  const hash = crypto.createHash(algo);
  try {
    await pipeline(Readable.fromWeb(res.body), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } }), fs.createWriteStream(archive));
    if (hash.digest("base64") !== expected) throw new Error(`engine download failed its integrity check (${algo} mismatch for omniroute ${ver}) — not installed`);

    // strip:1 drops the leading "package/" dir. Only extract what the
    // standalone server needs.
    onProgress && onProgress({ phase: "extract", detail: "Verified. Unpacking engine…" });
    await tar.x({
      file: archive,
      cwd: dir,
      strip: 1,
      filter: (p) => {
        const rel = p.replace(/^package\//, "");
        return rel.startsWith("dist/") || rel === "package.json" || rel.startsWith("open-sse/") || rel.startsWith("scripts/");
      },
    });
  } finally {
    fs.rmSync(archive, { force: true });
  }

  if (!engineReady(dir)) throw new Error("engine extracted but dist/server.js missing");

  // The published tarball ships better-sqlite3 WITHOUT a native binary (npm builds
  // it on install). Copy the app's bundled, platform-correct build into the engine.
  try { copyNativeSqlite(dir); } catch (e) { onProgress && onProgress({ phase: "warn", detail: "sqlite copy: " + e.message }); }

  onProgress && onProgress({ phase: "ready", detail: "Engine ready" });
  return dir;
}

// Locate the app's bundled better-sqlite3 (complete, with build/*.node), mapping
// out of the asar archive if packaged.
function bundledBetterSqliteDir() {
  let dir = null;
  try { dir = path.dirname(require.resolve("better-sqlite3/package.json")); } catch {}
  if (!dir) {
    const p = path.join(__dirname, "..", "node_modules", "better-sqlite3");
    if (fs.existsSync(p)) dir = p;
  }
  if (dir && dir.includes("app.asar" + path.sep)) {
    const unpacked = dir.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
    if (fs.existsSync(unpacked)) dir = unpacked;
  }
  return dir;
}

function copyNativeSqlite(engineRoot) {
  const src = bundledBetterSqliteDir();
  const dest = path.join(engineRoot, "dist", "node_modules", "better-sqlite3");
  if (!src || !fs.existsSync(dest)) return;
  for (const sub of ["build", "prebuilds"]) {
    const from = path.join(src, sub);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, sub), { recursive: true, force: true });
  }
}

module.exports = { engineDir, engineReady, downloadEngine, pinnedEngine };
