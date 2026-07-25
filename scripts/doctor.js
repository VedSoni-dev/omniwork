"use strict";
// Checks (and where possible repairs) the local dev setup.
//
// The common failure is electron's postinstall: it downloads a ~100 MB zip and
// extracts it with a pure-JS unzipper. If that step is interrupted — or npm
// defers install scripts, as npm 11+ does — you get a half-extracted
// node_modules/electron/dist and a missing path.txt, and `npm start` dies with
// "Electron failed to install correctly". Re-running the postinstall doesn't
// help, because it exits early on the partial directory.
//
// So we detect that state and re-extract from the already-downloaded zip in
// electron's cache, using the platform's native unzipper (ditto on macOS, which
// unlike unzip preserves the symlinks and bundle permissions inside the .app).
//
// Run: node scripts/doctor.js   (or: npm run doctor)

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ELECTRON_DIR = path.join(ROOT, "node_modules", "electron");

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const bad = (m) => { failures++; console.log(`  ❌ ${m}`); };

function platformPath() {
  switch (process.platform) {
    case "darwin": return "Electron.app/Contents/MacOS/Electron";
    case "win32": return "electron.exe";
    default: return "electron";
  }
}

function electronCacheZip(version) {
  const base = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "electron")
    : process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "electron", "Cache")
      : path.join(os.homedir(), ".cache", "electron");
  if (!fs.existsSync(base)) return null;
  const wanted = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  for (const entry of fs.readdirSync(base)) {
    const zip = path.join(base, entry, wanted);
    if (fs.existsSync(zip)) return zip;
  }
  return null;
}

function extractZip(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === "darwin") {
    // ditto keeps symlinks + the executable bit inside the .app bundle.
    execFileSync("ditto", ["-xk", zip, dest], { stdio: "inherit" });
  } else if (process.platform === "win32") {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-qq", "-o", zip, "-d", dest], { stdio: "inherit" });
  }
}

function checkElectron() {
  console.log("\nelectron runtime");
  if (!fs.existsSync(ELECTRON_DIR)) {
    bad("node_modules/electron missing — run: npm install --legacy-peer-deps");
    return;
  }
  const version = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, "package.json"), "utf8")).version;
  const dist = path.join(ELECTRON_DIR, "dist");
  const binary = path.join(dist, platformPath());
  const pathTxt = path.join(ELECTRON_DIR, "path.txt");

  const healthy = fs.existsSync(binary) && fs.existsSync(pathTxt) && fs.existsSync(path.join(dist, "version"));
  if (healthy) { ok(`electron ${version} installed`); return; }

  warn(`electron ${version} is installed but its binary is incomplete — repairing…`);
  const zip = electronCacheZip(version);
  if (!zip) {
    bad(`no cached zip for electron ${version} (${process.platform}-${process.arch}).\n` +
        `     Fix with: rm -rf node_modules/electron && npm install electron@${version} --legacy-peer-deps`);
    return;
  }
  try {
    extractZip(zip, dist);
    fs.writeFileSync(pathTxt, platformPath());
    if (fs.existsSync(binary)) ok(`repaired electron ${version} from cached download`);
    else bad("re-extraction finished but the binary is still missing");
  } catch (e) {
    bad(`repair failed: ${e.message}`);
  }
}

function checkEngine() {
  console.log("\nomniroute engine");
  const server = path.join(ROOT, "node_modules", "omniroute", "dist", "server.js");
  if (fs.existsSync(server)) ok("gateway server present (full build)");
  else warn("not bundled — the app will download it on first launch (lite mode)");
}

function checkIcon() {
  console.log("\napp icon");
  const icon = path.join(ROOT, "assets", "icon.png");
  if (fs.existsSync(icon)) { ok("assets/icon.png present"); return; }
  try {
    execFileSync(process.execPath, [path.join(__dirname, "gen-icon.js")], { stdio: "inherit" });
    ok("generated assets/icon.png");
  } catch { bad("could not generate assets/icon.png"); }
}

function checkNode() {
  console.log("\nnode runtime");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} — OmniRoute's gateway needs Node 22+`);
}

console.log("OmniWork doctor");
checkNode();
checkElectron();
checkEngine();
checkIcon();

console.log(failures ? `\n${failures} problem(s) need attention.\n` : "\nAll good — run `npm start`.\n");
process.exit(failures ? 1 : 0);
