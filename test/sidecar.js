// Gateway port recovery. The regression that motivated this: a process that
// accepts the connection and then never answers used to park the health probe
// forever, so a wedged gateway holding port 20128 made every subsequent boot
// fail with EADDRINUSE and a useless "Gateway exited (code 1)".
//
// Fast and deterministic — no OmniRoute here. The full boot path is covered by
// test/smoke.js.
const net = require("node:net");
const http = require("node:http");
const { probeGateway, portAvailable, freePort } = require("../electron/sidecar");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

(async () => {
  // ── a port with nothing on it ──
  const dead = await freePort();
  const t0 = Date.now();
  check("closed port probes false", (await probeGateway(dead, 2000)) === false);
  check("…and fails fast, without waiting out the timeout", Date.now() - t0 < 1500);

  // ── wedged: accepts the socket, never replies ──
  const wedged = net.createServer(() => { /* hold the connection open, say nothing */ });
  const wedgedPort = await listen(wedged);
  const t1 = Date.now();
  const wedgedResult = await probeGateway(wedgedPort, 1000);
  const wedgedMs = Date.now() - t1;
  check("wedged listener probes false", wedgedResult === false);
  check("wedged listener gives up at the timeout, not never", wedgedMs >= 900 && wedgedMs < 4000);

  // ── healthy ──
  const healthy = http.createServer((req, res) => {
    if (req.url.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); }
    else { res.writeHead(404); res.end(); }
  });
  const healthyPort = await listen(healthy);
  check("healthy gateway probes true", (await probeGateway(healthyPort, 2000)) === true);

  // ── 401: serving, just wants a key. Still a live gateway. ──
  const guarded = http.createServer((req, res) => { res.writeHead(401); res.end(); });
  const guardedPort = await listen(guarded);
  check("401 counts as a live gateway", (await probeGateway(guardedPort, 2000)) === true);

  // ── 500: listening but broken storage — not healthy ──
  const broken = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  const brokenPort = await listen(broken);
  check("500 does not count as healthy", (await probeGateway(brokenPort, 2000)) === false);

  // ── the pre-flight bind check ──
  // Since 0.11.1 the child's output goes to /dev/null so a detached gateway can
  // outlive us, which means we never see its EADDRINUSE. Asking the OS whether
  // we could bind is what replaces reading that.
  check("a port nobody holds is available", (await portAvailable(dead)) === true);
  check("a wedged listener's port is not available", (await portAvailable(wedgedPort)) === false);
  check("a healthy gateway's port is not available", (await portAvailable(healthyPort)) === false);
  check("checking availability does not steal the port", (await portAvailable(dead)) === true);

  // ── freePort hands back something actually bindable ──
  const p = await freePort();
  const bound = await new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
  });
  check("freePort returns a bindable port", bound === true);
  check("freePort does not return the well-known port", p !== 20128);

  for (const s of [wedged, healthy, guarded, broken]) s.close();
  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ SIDECAR PORT RECOVERY TEST PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("crash:", e.message); process.exit(1); });
