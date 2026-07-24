"use strict";
// Lite build: OmniRoute is NOT bundled in the installer. On first run we download
// the omniroute npm tarball and extract just its prebuilt server (dist/) into the
// app data dir. Subsequent launches reuse it. Full builds skip this entirely.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// The version to fetch. Kept in sync with package.json's omniroute dependency.
function omnirouteVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return (pkg.dependencies.omniroute || "").replace(/^[^0-9]*/, "") || "3.8.48";
  } catch { return "3.8.48"; }
}

function engineDir(dataDir) { return path.join(dataDir, "engine", "omniroute"); }

// True if a usable engine is already present (bundled or previously downloaded).
function engineReady(dir) {
  return fs.existsSync(path.join(dir, "dist", "server.js"));
}

// Download + extract omniroute's dist/ into <dataDir>/engine/omniroute.
async function downloadEngine(dataDir, onProgress) {
  const tar = require("tar"); // small, battle-tested; bundled in both builds
  const ver = omnirouteVersion();
  const url = `https://registry.npmjs.org/omniroute/-/omniroute-${ver}.tgz`;
  const dir = engineDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });

  onProgress && onProgress({ phase: "download", detail: `Fetching engine v${ver}…` });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`engine download failed: HTTP ${res.status}`);

  // Stream the .tgz straight through tar's extractor. strip:1 drops the leading
  // "package/" dir. Only extract what the standalone server needs.
  onProgress && onProgress({ phase: "extract", detail: "Unpacking engine…" });
  await pipeline(
    Readable.fromWeb(res.body),
    tar.x({
      cwd: dir,
      strip: 1,
      filter: (p) => {
        const rel = p.replace(/^package\//, "");
        return rel.startsWith("dist/") || rel === "package.json" || rel.startsWith("open-sse/") || rel.startsWith("scripts/");
      },
    })
  );

  if (!engineReady(dir)) throw new Error("engine extracted but dist/server.js missing");
  onProgress && onProgress({ phase: "ready", detail: "Engine ready" });
  return dir;
}

module.exports = { engineDir, engineReady, downloadEngine };
