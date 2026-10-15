"use strict";
// Gateway storage survives a slow boot. The regression: when the first boot
// attempt failed for any reason — a timeout on a slow disk, a port race — the
// sidecar renamed storage.sqlite to *.corrupt-<ts>.bak, silently wiping every
// provider connection; one machine had 14 such resets, all world-readable.
//
// Now the database is set aside only when SQLite says it is corrupt, with its
// WAL, as an owner-only backup, keeping the newest two — and the user is told.
//
// A stand-in gateway (behaviour read from a file beside it) replaces OmniRoute.
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const mode = (f) => fs.statSync(f).mode & 0o777;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let DatabaseSync = null;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}

(async () => {
  // Never the well-known port: a real gateway may be running there.
  process.env.OMNIWORK_GATEWAY_PORT = String(await freePort());
  process.env.OMNIWORK_NODE = process.execPath;
  // …and never the real ~/.omniwork for the key and the running-gateway record.
  process.env.OMNIWORK_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-storage-rt-"));
  const { Gateway, checkStorage, quarantineStorage, storageBackups } = require("../electron/sidecar");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniwork-storage-"));
  const omniDir = path.join(root, "fake-omni");
  fs.mkdirSync(path.join(omniDir, "dist"), { recursive: true });
  // behaviour: "hang" (listens, never answers), "exit", "healthy", or
  // "hang-then-healthy" (first spawn hangs, later ones answer).
  fs.writeFileSync(path.join(omniDir, "dist", "server.js"), `
const fs = require("fs"), http = require("http"), path = require("path");
const behaviour = fs.readFileSync(path.join(__dirname, "behaviour.txt"), "utf8").trim();
const countFile = path.join(__dirname, "spawns.txt");
const n = (Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : 0) || 0) + 1;
fs.writeFileSync(countFile, String(n));
if (behaviour === "exit") process.exit(1);
const healthy = behaviour === "healthy" || (behaviour === "hang-then-healthy" && n > 1);
http.createServer((req, res) => { if (healthy) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); } })
  .listen(Number(process.env.PORT), process.env.HOSTNAME || "127.0.0.1");
`);
  const behave = (b) => { fs.writeFileSync(path.join(omniDir, "dist", "behaviour.txt"), b); fs.rmSync(path.join(omniDir, "dist", "spawns.txt"), { force: true }); };
  const spawns = () => Number(fs.readFileSync(path.join(omniDir, "dist", "spawns.txt"), "utf8"));

  const makeDb = (file) => {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE provider_connections(id TEXT, provider TEXT); INSERT INTO provider_connections VALUES ('c1', 'openrouter');");
    db.close();
  };
  const freshDataDir = (name) => { const d = path.join(root, name); fs.mkdirSync(path.join(d, "omniroute"), { recursive: true }); return d; };
  const boot = async (dataDir) => {
    const statuses = [];
    const gw = new Gateway({ dataDir, omniDir, healthTimeoutMs: 1200, onStatus: (s) => statuses.push(s) });
    let error = null;
    try { await gw.start(); } catch (e) { error = e; }
    return { gw, error, statuses };
  };

  // ── the verdicts ──
  const v = path.join(root, "verdicts");
  fs.mkdirSync(v);
  fs.writeFileSync(path.join(v, "garbage.sqlite"), "definitely not a database ".repeat(20));
  fs.writeFileSync(path.join(v, "tiny.sqlite"), "short");
  check("non-SQLite content is corrupt", (await checkStorage(path.join(v, "garbage.sqlite"))) === "corrupt");
  check("a truncated stub is corrupt", (await checkStorage(path.join(v, "tiny.sqlite"))) === "corrupt");
  check("a missing file is not called corrupt", (await checkStorage(path.join(v, "absent.sqlite"))) === "unknown");
  if (DatabaseSync) {
    makeDb(path.join(v, "good.sqlite"));
    check("a sound database is ok", (await checkStorage(path.join(v, "good.sqlite"))) === "ok");
  } else console.log("- node:sqlite unavailable in this Node; skipping the sound-database checks");

  // ── a slow boot keeps a sound database ──
  if (DatabaseSync) {
    const dataDir = freshDataDir("slow");
    const db = path.join(dataDir, "omniroute", "storage.sqlite");
    makeDb(db);
    behave("hang");
    const { error, statuses } = await boot(dataDir);
    check("a boot that never turns healthy still fails", Boolean(error));
    check("…after exactly one retry", spawns() === 2);
    check("storage.sqlite survives a boot timeout", fs.existsSync(db) && (await checkStorage(db)) === "ok");
    check("no backup is made of a sound database", storageBackups(path.join(dataDir, "omniroute")).length === 0);
    check("the retry is described as a slow start, not a recovery", statuses.some((s) => /slow to start/i.test(s.detail || "")) && !statuses.some((s) => /reset|recover/i.test(s.detail || "")));
  }

  // ── a corrupt database is set aside, owner-only, and the user is told ──
  {
    const dataDir = freshDataDir("corrupt");
    const store = path.join(dataDir, "omniroute");
    fs.writeFileSync(path.join(store, "storage.sqlite"), "garbage where a database should be ".repeat(20), { mode: 0o644 });
    fs.writeFileSync(path.join(store, "storage.sqlite-wal"), "stale wal", { mode: 0o644 });
    for (const ts of [1000, 2000, 3000]) fs.writeFileSync(path.join(store, `storage.sqlite.corrupt-${ts}.bak`), "old keys", { mode: 0o644 });
    behave("hang-then-healthy");
    const { gw, error, statuses } = await boot(dataDir);
    check("after setting corrupt storage aside, the gateway boots", !error && gw.ready);
    const backups = storageBackups(store);
    check("the corrupt database becomes a backup", !fs.existsSync(path.join(store, "storage.sqlite")) && backups.length && Number(backups[0].match(/\d+/)[0]) > 3000);
    check("its WAL moves with it, so it can't be replayed into the fresh one", !fs.existsSync(path.join(store, "storage.sqlite-wal")) && fs.existsSync(path.join(store, backups[0] + "-wal")));
    check("only the newest two backups are kept", backups.length === 2 && backups[1] === "storage.sqlite.corrupt-3000.bak");
    check("backups are owner-only (0600)", backups.every((b) => mode(path.join(store, b)) === 0o600) && mode(path.join(store, backups[0] + "-wal")) === 0o600);
    check("the user is told the storage was reset", statuses.some((s) => s.state === "boot" && /reset/.test(s.detail || "")) && statuses.some((s) => s.state === "ready" && /reset/.test(s.detail || "")));
    check("the reset is recorded on the gateway", Boolean(gw.storageReset && gw.storageReset.backup === path.join(store, backups[0])));
    gw.stop();
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── existing backups are locked down on every start, even a failing one ──
  {
    const dataDir = freshDataDir("legacy");
    const store = path.join(dataDir, "omniroute");
    fs.writeFileSync(path.join(store, "storage.sqlite.corrupt-42.bak"), "old keys", { mode: 0o644 });
    behave("exit");
    await boot(dataDir);
    check("backups from earlier versions become owner-only", mode(path.join(store, "storage.sqlite.corrupt-42.bak")) === 0o600);
    check("…and are not deleted unless a new backup is made", fs.existsSync(path.join(store, "storage.sqlite.corrupt-42.bak")));
  }

  // ── quarantineStorage on its own ──
  {
    const store = path.join(root, "direct");
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, "storage.sqlite"), "x");
    const backup = quarantineStorage(store, 5000);
    check("quarantineStorage returns the backup path", backup === path.join(store, "storage.sqlite.corrupt-5000.bak") && fs.existsSync(backup));
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(process.env.OMNIWORK_RUNTIME_DIR, { recursive: true, force: true });
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ GATEWAY STORAGE TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.stack); process.exit(1); });
