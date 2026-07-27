// Unit test: pending-approval lifecycle — the exact mechanics behind the
// "switch away during an approval and the turn hangs forever" bug. Drives the
// approver callback SessionManager wires into each agent; no gateway needed.
const os = require("os");
const { SessionManager } = require("../electron/sessions");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const events = [];
  const sm = new SessionManager({
    gateway: { baseUrl: "http://127.0.0.1:9", apiKey: "x" },
    mcp: null,
    emit: (id, type, p) => events.push({ id, type, p }),
  });
  const s = sm.create({ workspace: os.tmpdir(), title: "T" });
  const sess = sm.sessions.get(s.id);

  // an approval request parks the turn and is remembered on the session
  let verdict1 = null;
  sess.agent.approver("c1", "run_command", { command: "echo hi" }, null).then((v) => (verdict1 = v));
  await tick();
  check("pending approval remembered on the session", sess.pendingApproval && sess.pendingApproval.callId === "c1");
  check("approval_request emitted to the renderer", events.some((e) => e.type === "approval_request" && e.p.callId === "c1"));
  check("turn is parked until answered", verdict1 === null);

  // answering resolves the turn and clears the memo (what re-rendered cards call)
  sm.resolveApproval("c1", true);
  await tick();
  check("approve resolves the parked turn", verdict1 === true);
  check("memo cleared after answering", sess.pendingApproval === null);

  // Esc during a parked approval: stop() must deny it so abort can take effect
  let verdict2 = null;
  sess.agent.approver("c2", "write_file", { path: "x" }, null).then((v) => (verdict2 = v));
  await tick();
  sm.stop(s.id);
  await tick();
  check("stop() denies the parked approval", verdict2 === false);
  check("stop() aborts the agent", sess.agent.aborted === true);
  check("memo cleared on stop", sess.pendingApproval === null);

  console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ APPROVALS TEST PASSED");
  process.exit(fails ? 1 : 0);
})();
