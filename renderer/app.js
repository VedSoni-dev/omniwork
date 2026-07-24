"use strict";
const stub = {
  createSession: async () => ({ id: "demo", title: "Main", workspace: "", status: "idle" }),
  listSessions: async () => ({ sessions: [], activeId: null }), setActiveSession: async () => {},
  getTranscript: async () => [], sendMessage: async () => {}, stopSession: async () => {},
  removeSession: async () => {}, pickWorkspace: async () => {},
  listMcp: async () => [], addMcp: async () => [], removeMcp: async () => [],
  listDir: async () => ({ root: null, entries: [] }), readFile: async () => ({ content: "" }),
  getState: async () => ({ model: "auto", sessions: [], activeId: null, mcp: [] }),
  setModel: async () => {}, openDashboard: async () => {}, on: () => () => {},
};
const api = window.omniwork || stub;
const $ = (id) => document.getElementById(id);
const scroll = $("scroll");
const input = $("input");
const stopBtn = $("stop");

let activeId = null;
let sessionsCache = [];
let fileIndex = null;
let thinkingEl = null, thinkTimer = null;
const mentions = new Set();

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const scrollDown = () => (scroll.scrollTop = scroll.scrollHeight);
const activeSession = () => sessionsCache.find((s) => s.id === activeId);

function md(text) {
  const parts = String(text).split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) html += `<pre><code>${esc(parts[i].replace(/^[a-zA-Z0-9]*\n/, ""))}</code></pre>`;
    else html += esc(parts[i]).replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  return html;
}

// ── terminal rendering ─────────────────────────────────────────────
function welcome() {
  const s = activeSession();
  const cwd = s ? s.workspace : "—";
  const el = document.createElement("div");
  el.className = "welcome";
  el.innerHTML =
    `<div class="wbox">` +
    `<div class="wline"><span class="accent">✻</span> <b>${esc(s ? s.title : "OmniWork")}</b> · Claude Code–style agent</div>` +
    `<div class="wline dim"></div>` +
    `<div class="wline dim">free models via OmniRoute · MCP connections · run many in parallel</div>` +
    `<div class="wline dim">cwd: <span class="cwd">${esc(cwd)}</span> <button class="inline-btn" id="w-cwd">change</button></div>` +
    `<div class="wline dim">type <span class="kbd">@</span> for a file · <span class="kbd">Enter</span> to send</div></div>` +
    `<div class="tips">` +
    `<button class="tip" data-p="Give me a tour of this codebase — list the top-level files and explain the architecture.">explain this codebase</button>` +
    `<button class="tip" data-p="Fetch https://news.ycombinator.com and summarize the top 5 stories.">browse the web</button>` +
    `<button class="tip" data-p="Find and fix any bugs you can spot, then summarize the changes.">find & fix bugs</button></div>`;
  scroll.appendChild(el);
  $("w-cwd")?.addEventListener("click", () => api.pickWorkspace(activeId));
}

function addUser(text) { stopThinking(); const e = document.createElement("div"); e.className = "blk user"; e.innerHTML = `<span class="caret">&gt;</span><span class="utext">${esc(text)}</span>`; scroll.appendChild(e); scrollDown(); }
function addAssistant(text) { stopThinking(); const e = document.createElement("div"); e.className = "blk assistant"; e.innerHTML = md(text); scroll.appendChild(e); scrollDown(); }
function addError(msg) { stopThinking(); const e = document.createElement("div"); e.className = "errline"; e.textContent = "✗ " + msg; scroll.appendChild(e); scrollDown(); }

function diffHtml(o, n) { let h = ""; (o || "").split("\n").forEach((l) => (h += `<span class="del">- ${esc(l)}</span>\n`)); (n || "").split("\n").forEach((l) => (h += `<span class="add">+ ${esc(l)}</span>\n`)); return h; }
function toolTitle(name, args) {
  const label = { run_command: "Bash", read_file: "Read", write_file: "Write", edit_file: "Edit", list_dir: "List", web_fetch: "Fetch", open_url: "Open" }[name]
    || (name.startsWith("mcp__") ? name.slice(5).replace("__", " · ") : name);
  let a = name === "run_command" ? args.command : args.path || args.url || Object.values(args || {})[0] || "";
  return { label, a: String(a || "").slice(0, 120) };
}
const toolEls = new Map();
function addToolCard(id, name, args) {
  stopThinking();
  const { label, a } = toolTitle(name, args);
  const el = document.createElement("div"); el.className = "tool";
  const isDiff = name === "edit_file" || name === "write_file";
  el.innerHTML =
    `<div class="tool-line"><span class="tool-dot">⏺</span><span class="tool-title"><span class="tname">${esc(label)}</span><span class="targs">(${esc(a)})</span></span><span class="spin">…</span></div>` +
    `<div class="tool-body"><span class="tool-elbow">⎿</span><div class="tool-out"></div></div>`;
  const out = el.querySelector(".tool-out"), body = el.querySelector(".tool-body");
  if (name === "edit_file") out.innerHTML = diffHtml(args.old_string, args.new_string);
  else if (name === "write_file") out.innerHTML = `<span class="add">+ created ${esc(args.path || "")}</span>\n` + esc(String(args.content || "").slice(0, 2000));
  else body.style.display = "none";
  scroll.appendChild(el);
  toolEls.set(id, { out, body, spin: el.querySelector(".spin"), dot: el.querySelector(".tool-dot"), isDiff });
  scrollDown();
}
function streamTool(id, chunk) { const t = toolEls.get(id); if (t && !t.isDiff) { t.body.style.display = "flex"; t.out.textContent += chunk; scrollDown(); } }
function finishTool(id, result) { const t = toolEls.get(id); if (!t) return; if (t.spin) t.spin.remove(); t.dot.classList.add("done"); if (!t.isDiff && !t.out.textContent) { t.body.style.display = "flex"; t.out.textContent = result; } scrollDown(); }

const GLYPHS = ["✻", "✳", "✶", "✽", "✢", "✦"];
function startThinking() { stopThinking(); thinkingEl = document.createElement("div"); thinkingEl.className = "thinking"; thinkingEl.innerHTML = `<span class="glyph">✻</span> Working…`; scroll.appendChild(thinkingEl); scrollDown(); let i = 0; thinkTimer = setInterval(() => { const g = thinkingEl && thinkingEl.querySelector(".glyph"); if (g) g.textContent = GLYPHS[i++ % GLYPHS.length]; }, 260); }
function stopThinking() { if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; } if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }

function renderEvent(ev, live) {
  switch (ev.type) {
    case "user": addUser(ev.content); break;
    case "assistant": addAssistant(ev.content); break;
    case "tool_call": addToolCard(ev.id, ev.name, ev.args); break;
    case "tool_stream": if (live) streamTool(ev.id, ev.chunk); break;
    case "tool_result": finishTool(ev.id, ev.result); break;
    case "thinking": if (live) startThinking(); break;
    case "error": addError(ev.message); break;
    case "done": case "aborted": if (live) stopThinking(); break;
  }
}

// ── session switching ──────────────────────────────────────────────
async function switchTo(id) {
  activeId = id;
  await api.setActiveSession(id);
  toolEls.clear(); stopThinking();
  scroll.innerHTML = "";
  const t = await api.getTranscript(id);
  if (!t || !t.length) welcome();
  else for (const ev of t) renderEvent(ev, false);
  updateCwd(); syncComposer(); scrollDown();
  input.focus();
}

function updateCwd() { const s = activeSession(); $("cwd-mini").textContent = s ? s.workspace : ""; }
function syncComposer() { const s = activeSession(); const running = s && s.status === "running"; stopBtn.classList.toggle("hidden", !running); }

// ── rail rendering ─────────────────────────────────────────────────
function renderSessions(list, act) {
  sessionsCache = list; if (act !== undefined) activeId = act ?? activeId;
  const box = $("session-list"); box.innerHTML = "";
  list.forEach((s) => {
    const el = document.createElement("div");
    el.className = "sitem" + (s.id === activeId ? " active" : "");
    const base = (s.workspace || "").split(/[\\/]/).pop() || "~";
    el.innerHTML = `<span class="sdot ${s.status}"></span><span class="sinfo"><span class="stitle">${esc(s.title)}</span><span class="scwd">${esc(base)}</span></span><span class="sx" title="Close">✕</span>`;
    el.addEventListener("click", (e) => { if (e.target.classList.contains("sx")) { api.removeSession(s.id); return; } if (s.id !== activeId) switchTo(s.id); });
    box.appendChild(el);
  });
  syncComposer(); updateCwd();
}

function renderMcp(servers) {
  const box = $("mcp-list"); box.innerHTML = "";
  if (!servers || !servers.length) { box.innerHTML = `<div class="rail-empty">No connections. + to add tools.</div>`; return; }
  servers.forEach((s) => {
    const el = document.createElement("div"); el.className = "mitem-row";
    const cnt = s.status === "connected" ? `${s.tools.length} tools` : (s.error ? "error" : s.status);
    el.innerHTML = `<span class="mdot ${s.status}"></span><span class="mname" title="${esc(s.tools.join(', '))}">${esc(s.name)}</span><span class="mcount">${esc(cnt)}</span><span class="mx" title="Remove">✕</span>`;
    el.querySelector(".mx").addEventListener("click", () => api.removeMcp(s.name));
    box.appendChild(el);
  });
}

// ── events from main ───────────────────────────────────────────────
api.on("session:event", (p) => { if (p.sessionId === activeId) renderEvent(p, true); });
api.on("sessions:list", (p) => renderSessions(p.sessions, p.activeId));
api.on("mcp:list", (p) => renderMcp(p.servers));
api.on("gateway:status", (s) => { const d = $("gw-dot"); d.className = "s-dot " + (s.state === "ready" ? "ok" : s.state === "error" ? "err" : "boot"); $("gw-label").textContent = s.state === "ready" ? "ready" : s.state === "error" ? "engine error" : "starting…"; });

// ── @-mentions ─────────────────────────────────────────────────────
function renderChips() { const box = $("chips"); box.innerHTML = ""; mentions.forEach((p) => { const c = document.createElement("span"); c.className = "chip"; c.innerHTML = `@${esc(p)} <span class="x">✕</span>`; c.querySelector(".x").addEventListener("click", () => { mentions.delete(p); renderChips(); }); box.appendChild(c); }); }
async function buildIndex() { if (fileIndex) return fileIndex; const out = []; async function walk(rel, d) { if (d > 4 || out.length > 2000) return; const res = await api.listDir(rel); if (!res.entries) return; for (const e of res.entries) { if (e.type === "file") out.push(e.path); else await walk(e.path, d + 1); } } await walk(".", 0); return (fileIndex = out); }
let mpop = null, mSel = 0, mMatches = [];
async function showPop(q) { const idx = await buildIndex(); mMatches = idx.filter((p) => p.toLowerCase().includes(q.toLowerCase())).slice(0, 20); hidePop(); if (!mMatches.length) return; mSel = 0; mpop = document.createElement("div"); mpop.className = "mpop"; mMatches.forEach((p, i) => { const it = document.createElement("div"); it.className = "mpitem" + (i === 0 ? " sel" : ""); it.innerHTML = `<span>${esc(p.split("/").pop())}</span><span class="mp">${esc(p)}</span>`; it.addEventListener("mousedown", (e) => { e.preventDefault(); pick(p); }); mpop.appendChild(it); }); document.body.appendChild(mpop); const r = $("inputbox").getBoundingClientRect(); mpop.style.left = r.left + "px"; mpop.style.bottom = window.innerHeight - r.top + 6 + "px"; mpop.style.width = Math.min(r.width, 480) + "px"; }
function hidePop() { if (mpop) mpop.remove(); mpop = null; mMatches = []; }
function moveSel(d) { if (!mpop) return; const items = [...mpop.querySelectorAll(".mpitem")]; items[mSel]?.classList.remove("sel"); mSel = (mSel + d + items.length) % items.length; items[mSel]?.classList.add("sel"); items[mSel]?.scrollIntoView({ block: "nearest" }); }
function pick(p) { mentions.add(p); renderChips(); input.value = input.value.replace(/@[^\s]*$/, "").trimEnd(); hidePop(); input.focus(); }

// ── composer ───────────────────────────────────────────────────────
function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
input.addEventListener("input", () => { grow(); const m = input.value.match(/@([^\s]*)$/); if (m) showPop(m[1]); else hidePop(); });
input.addEventListener("keydown", (e) => {
  if (mpop) { if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); return; } if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); return; } if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(mMatches[mSel]); return; } if (e.key === "Escape") { hidePop(); return; } }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === "Escape") api.stopSession(activeId);
});
async function send() {
  const text = input.value.trim();
  if ((!text && !mentions.size) || !activeId) return;
  let full = text; if (mentions.size) full = `${text}\n\nReferenced files: ${[...mentions].map((p) => "@" + p).join(", ")}`;
  const w = $("welcome"); if (w) w.remove();
  input.value = ""; const m = [...mentions]; mentions.clear(); renderChips(); grow(); hidePop();
  await api.sendMessage(activeId, full);
}
stopBtn.addEventListener("click", () => api.stopSession(activeId));
document.addEventListener("click", (e) => { const t = e.target.closest(".tip"); if (t) { input.value = t.dataset.p; grow(); input.focus(); } });

// ── new session / cwd / model / dashboard ──────────────────────────
$("new-session").addEventListener("click", async () => { const s = await api.createSession({}); if (s) { fileIndex = null; await switchTo(s.id); } });
$("change-cwd").addEventListener("click", () => api.pickWorkspace(activeId));
$("dashboard").addEventListener("click", () => api.openDashboard());
$("model").addEventListener("change", (e) => api.setModel(e.target.value));

// ── MCP modal ──────────────────────────────────────────────────────
$("add-mcp").addEventListener("click", () => $("modal").classList.remove("hidden"));
$("m-cancel").addEventListener("click", () => $("modal").classList.add("hidden"));
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("modal").classList.add("hidden"); });
document.querySelectorAll(".preset").forEach((b) => b.addEventListener("click", () => { $("m-name").value = b.dataset.name; $("m-cmd").value = b.dataset.cmd; $("m-args").value = b.dataset.args; }));
$("m-add").addEventListener("click", async () => {
  const name = $("m-name").value.trim(); const command = $("m-cmd").value.trim(); const argsStr = $("m-args").value.trim();
  if (!name || !command) return;
  const conf = { command, args: argsStr ? argsStr.split(/\s+/) : [] };
  $("modal").classList.add("hidden"); $("m-name").value = ""; $("m-cmd").value = ""; $("m-args").value = "";
  await api.addMcp(name, conf);
});

// ── init ───────────────────────────────────────────────────────────
(async () => {
  const st = await api.getState();
  if (st) {
    if (st.model) $("model").value = st.model;
    if (st.mcp) renderMcp(st.mcp);
    if (st.sessions && st.sessions.length) { renderSessions(st.sessions, st.activeId); await switchTo(st.activeId || st.sessions[0].id); }
    else welcome();
  } else welcome();
  input.focus();
})();
