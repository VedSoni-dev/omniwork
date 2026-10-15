"use strict";
// Preloaded into the OmniRoute gateway process (`node --require`) by
// sidecar.js, before OmniRoute's server starts. Plain Node, no dependencies:
// packaged builds copy it out of app.asar, where Node can't read it.
//
// Everything the gateway writes — its database, call logs, backups — is
// owner-only: OmniRoute sets no file modes of its own.
//
// OmniRoute has no Host-header allowlist and decides "local" from the bind
// address, so a page the user has open could reach it by DNS rebinding (a
// hostname that resolves to 127.0.0.1), and any site could send it
// cross-origin requests. On the gateway's own port this rejects, before
// OmniRoute sees them:
//   - a Host other than this gateway's loopback address
//     (plus OMNIWORK_GATEWAY_ALLOWED_HOSTS, e.g. host.docker.internal);
//   - an Origin other than the gateway's own (the dashboard's same-origin
//     calls still pass; a cross-site page's do not).
const http = require("node:http");
const { isMainThread } = require("node:worker_threads");

// Process-wide; workers (OmniRoute writes call logs from one) inherit this
// preload too, and can't call umask.
if (isMainThread) process.umask(0o077);

const port = Number(process.env.PORT);
const names = ["127.0.0.1", "localhost", "[::1]",
  ...String(process.env.OMNIWORK_GATEWAY_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)];
const HOSTS = new Set(names.map((h) => `${h}:${port}`));
const ORIGINS = new Set(names.map((h) => `http://${h}:${port}`));

function refusal(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!HOSTS.has(host)) return "Forbidden host";
  const origin = req.headers.origin;
  if (origin !== undefined && !ORIGINS.has(String(origin).toLowerCase())) return "Forbidden origin";
  return null;
}

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function guarded(event, req, resOrSocket) {
  if ((event === "request" || event === "upgrade") && req && req.headers) {
    let local = null;
    try { local = this.address(); } catch {}
    const why = local && local.port === port ? refusal(req) : null;
    if (why) {
      if (event === "request") {
        resOrSocket.writeHead(403, { "Content-Type": "application/json", Connection: "close" });
        resOrSocket.end(JSON.stringify({ error: { message: `${why} — OmniWork's gateway only serves its own loopback address.`, type: "forbidden", code: "OMNIWORK_GUARD" } }));
      } else {
        try { resOrSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); } catch {}
        try { resOrSocket.destroy(); } catch {}
      }
      return true;
    }
  }
  return emit.apply(this, arguments);
};
