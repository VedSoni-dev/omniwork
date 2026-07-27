"use strict";
const stub = {
  createSession: async () => ({ id: "demo", title: "Main", workspace: "", status: "idle" }),
  newProject: async () => null, openMemory: async () => {}, compactSession: async () => {},
  listSkills: async () => [], installSkills: async () => ({ error: "unavailable" }), newSkill: async () => ({}), openSkills: async () => {},
  readMemory: async () => ({ content: "" }), writeMemory: async () => {}, openKnowledge: async () => {}, importKnowledge: async () => ({ added: [] }),
  listSessions: async () => ({ sessions: [], activeId: null }), setActiveSession: async () => {},
  getTranscript: async () => [], sendMessage: async () => {}, stopSession: async () => {},
  removeSession: async () => {}, pickWorkspace: async () => {},
  setWorkspacePath: async () => null, revealFolder: async () => {}, home: "",
  renameSession: async () => {}, renameProject: async () => {},
  listMcp: async () => [], addMcp: async () => [], removeMcp: async () => [],
  listDir: async () => ({ root: null, entries: [] }), readFile: async () => ({ content: "" }),
  getState: async () => ({ model: "auto", sessions: [], activeId: null, mcp: [] }),
  setModel: async () => {}, openDashboard: async () => {}, on: () => () => {},
};
const api = window.omniwork || stub;
// macOS uses a hidden-inset titlebar, so the rail needs room for the traffic lights.
document.documentElement.dataset.platform = api.platform || "web";
const $ = (id) => document.getElementById(id);
const scroll = $("scroll");
const input = $("input");
const stopBtn = $("stop");

let activeId = null;
let sessionsCache = [];
let skillsCache = [];
let fileIndex = null;
let thinkingEl = null, thinkTimer = null;
let streamEl = null, streamText = "";
let approvalMode = "auto";
let currentMcp = [];
const mentions = new Set();
const pastedImages = []; // data URLs
const attachedFiles = []; // { name, content } — text files attached as context

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const scrollDown = () => (scroll.scrollTop = scroll.scrollHeight);
const activeSession = () => sessionsCache.find((s) => s.id === activeId);
const baseName = (p) => (p || "").split(/[\\/]/).pop() || "~";
const prettyPath = (p) => (api.home && p && p.startsWith(api.home) ? "~" + p.slice(api.home.length) : p || "");

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
  const cwd = s ? s.workspace : "";
  const el = document.createElement("div");
  el.className = "welcome";
  el.id = "welcome"; // send()/handleSlash() remove it by id
  el.innerHTML =
    `<div class="wbox">` +
    `<div class="wline"><span class="accent">✻</span> <b>${esc(s ? s.title : "OmniWork")}</b></div>` +
    `<div class="wline dim wsub">Free AI models built in · add tools anytime · run tasks in parallel</div>` +
    `<div class="wline">Working in <span class="cwd">📁 ${esc(baseName(cwd))}</span> <span class="dim wpath">${esc(prettyPath(cwd))}</span> <button class="inline-btn" id="w-cwd">Change folder</button></div>` +
    `<div class="wline dim">type <span class="kbd">/</span> for commands · <span class="kbd">@</span> for a file · <span class="kbd">Enter</span> to send</div></div>` +
    `<div class="tips">` +
    `<button class="tip" data-p="Give me a tour of this codebase — list the top-level files and explain the architecture.">explain this codebase</button>` +
    `<button class="tip" data-p="Fetch https://news.ycombinator.com and summarize the top 5 stories.">browse the web</button>` +
    `<button class="tip" data-p="Find and fix any bugs you can spot, then summarize the changes.">find & fix bugs</button></div>`;
  scroll.appendChild(el);
  $("w-cwd")?.addEventListener("click", () => api.pickWorkspace(activeId));
}

function addUser(text) { stopThinking(); endStream(); const e = document.createElement("div"); e.className = "blk user"; e.innerHTML = `<span class="caret">&gt;</span><span class="utext">${esc(text)}</span>`; scroll.appendChild(e); scrollDown(); }
function addAssistant(text) { stopThinking(); const e = document.createElement("div"); e.className = "blk assistant"; e.innerHTML = md(text); scroll.appendChild(e); scrollDown(); }
function addError(msg) { stopThinking(); endStream(); const e = document.createElement("div"); e.className = "errline"; e.textContent = "✗ " + msg; scroll.appendChild(e); scrollDown(); }
function addSystem(text) { const e = document.createElement("div"); e.className = "sysline"; e.textContent = text; scroll.appendChild(e); scrollDown(); }

// live streaming assistant text
function streamDelta(chunk) {
  stopThinking();
  if (!streamEl) { streamEl = document.createElement("div"); streamEl.className = "blk assistant streaming"; streamText = ""; scroll.appendChild(streamEl); }
  streamText += chunk;
  streamEl.textContent = streamText;
  scrollDown();
}
function endStream(finalText) {
  if (!streamEl) { return false; }
  streamEl.classList.remove("streaming");
  streamEl.innerHTML = md(finalText != null ? finalText : streamText);
  streamEl = null; streamText = "";
  return true;
}

// approval prompt card
function apDiff(preview) {
  const cap = (s) => (s.length > 2400 ? s.slice(0, 2400) + "\n…" : s);
  let h = "";
  if (preview.created) h += `<span class="add">+ new file ${esc(preview.path || "")}</span>\n`;
  cap(preview.old || "").split("\n").forEach((l) => { if (l !== "" || preview.old) h += `<span class="del">- ${esc(l)}</span>\n`; });
  cap(preview.new || "").split("\n").forEach((l) => h += `<span class="add">+ ${esc(l)}</span>\n`);
  return h;
}
function addApproval(callId, name, args, preview) {
  stopThinking(); endStream();
  const label = { run_command: "run a command", write_file: "write a file", edit_file: "edit a file" }[name] || (name.startsWith("mcp__") ? "call " + name.slice(5).replace("__", " · ") : name);
  let detailHtml;
  if (preview && preview.kind === "diff") detailHtml = `<div class="ap-path dim">${esc(preview.path || "")}</div>${apDiff(preview)}`;
  else { const detail = name === "run_command" ? args.command : (args.path || args.url || JSON.stringify(args).slice(0, 200)); detailHtml = esc(String(detail || "")); }
  const el = document.createElement("div");
  el.className = "approval";
  el.innerHTML = `<div class="ap-q">⚠ Allow OmniWork to <b>${esc(label)}</b>?</div><div class="ap-detail mono">${detailHtml}</div><div class="ap-btns"><button class="ap-yes">Approve</button><button class="ap-no">Deny</button><span class="ap-hint dim">y / n</span></div>`;
  const decide = (ok) => { el.querySelector(".ap-btns").innerHTML = `<span class="${ok ? "green" : "dim"}">${ok ? "✓ approved" : "✕ denied"}</span>`; api.approve(callId, ok); pendingApproval = null; };
  el.querySelector(".ap-yes").addEventListener("click", () => decide(true));
  el.querySelector(".ap-no").addEventListener("click", () => decide(false));
  scroll.appendChild(el); scrollDown();
  pendingApproval = decide;
}
let pendingApproval = null;

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

// ── turn stats (time + tokens, like Claude Code's spinner line) ────
let turnStart = null, turnStats = null;
const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
function liveStatsText() {
  if (turnStart == null) return "";
  let t = fmtDur(Date.now() - turnStart);
  if (turnStats && turnStats.outTokens) t += ` · ↓ ${turnStats.estimated ? "~" : ""}${fmtTokens(turnStats.outTokens)} tokens`;
  return ` (${t})`;
}
function addStatsLine(ev, ok) {
  if (ev.outTokens == null) return; // pre-stats transcripts
  const e = document.createElement("div");
  e.className = "statline";
  e.innerHTML = `<span class="${ok ? "green" : "dim"}">${ok ? "✔" : "✕"}</span> ${fmtDur(ev.elapsedMs || 0)} · ↓ ${ev.estimated ? "~" : ""}${fmtTokens(ev.outTokens)} tokens`;
  scroll.appendChild(e); scrollDown();
}

const GLYPHS = ["✻", "✳", "✶", "✽", "✢", "✦"];
function startThinking() {
  stopThinking();
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML = `<span class="glyph">✻</span> Working…<span class="tstats dim"></span>`;
  scroll.appendChild(thinkingEl); scrollDown();
  let i = 0;
  thinkTimer = setInterval(() => {
    if (!thinkingEl) return;
    const g = thinkingEl.querySelector(".glyph");
    if (g) g.textContent = GLYPHS[i++ % GLYPHS.length];
    const s = thinkingEl.querySelector(".tstats");
    if (s) s.textContent = liveStatsText();
  }, 260);
}
function stopThinking() { if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; } if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }

function renderEvent(ev, live) {
  switch (ev.type) {
    case "user": addUser(ev.content); if (live) { turnStart = Date.now(); turnStats = null; } break;
    case "assistant_delta": if (live) streamDelta(ev.chunk); break;
    case "assistant": if (!endStream(ev.content)) addAssistant(ev.content); break;
    case "system": addSystem(ev.content); break;
    case "approval_request": if (live) addApproval(ev.callId, ev.name, ev.args, ev.preview); break;
    case "tool_call": endStream(); addToolCard(ev.id, ev.name, ev.args); break;
    case "tool_stream": if (live) streamTool(ev.id, ev.chunk); break;
    case "tool_result": finishTool(ev.id, ev.result); break;
    case "thinking": if (live && !streamEl) startThinking(); break;
    case "context": if (live) updateCtxMeter(ev.pct); break;
    case "stats": if (live) turnStats = ev; break;
    case "subagent": handleSubagent(ev); break;
    case "error": addError(ev.message); break;
    case "done": case "aborted":
      if (live) { endStream(); stopThinking(); turnStart = null; turnStats = null; }
      addStatsLine(ev, ev.type === "done");
      break;
  }
}

// ── Agent Deck ─────────────────────────────────────────────────────
const decks = new Map(); // groupId -> { grid, head, cards: Map }
function deckFor(groupId, count) {
  let d = decks.get(groupId);
  if (d) return d;
  stopThinking();
  const el = document.createElement("div");
  el.className = "deck";
  el.innerHTML = `<div class="deck-head"><span class="deck-ic">⛁</span> Agent Deck <span class="deck-meta">· ${count || ""} subagents</span></div><div class="deck-grid"></div>`;
  scroll.appendChild(el);
  d = { el, head: el.querySelector(".deck-head"), grid: el.querySelector(".deck-grid"), cards: new Map(), count: count || 0, done: 0 };
  decks.set(groupId, d);
  scrollDown();
  return d;
}
function deckCard(d, subId, title) {
  let c = d.cards.get(subId);
  if (c) return c;
  const el = document.createElement("div");
  el.className = "dcard";
  el.innerHTML = `<div class="dc-top"><span class="dc-dot"></span><span class="dc-title">${esc(title || subId)}</span></div><div class="dc-action">queued…</div>`;
  d.grid.appendChild(el);
  c = { el, dot: el.querySelector(".dc-dot"), action: el.querySelector(".dc-action") };
  d.cards.set(subId, c);
  return c;
}
function handleSubagent(ev) {
  if (ev.kind === "group_start") { deckFor(ev.groupId, ev.count); return; }
  const d = deckFor(ev.groupId, ev.count);
  if (ev.kind === "group_done") { d.head.querySelector(".deck-meta").textContent = "· done"; d.el.classList.add("deck-done"); return; }
  const c = deckCard(d, ev.subId, ev.title);
  switch (ev.kind) {
    case "start": c.dot.className = "dc-dot running"; c.action.textContent = "starting…"; break;
    case "tool": c.dot.className = "dc-dot running"; c.action.textContent = "⏺ " + ev.tool; break;
    case "text": c.action.textContent = ev.snippet; break;
    case "error": c.dot.className = "dc-dot error"; c.action.textContent = "✗ " + (ev.message || "error"); break;
    case "done": c.dot.className = "dc-dot done"; if (!c.action.textContent.startsWith("✗")) c.action.textContent = "✓ done"; break;
  }
  scrollDown();
}

// ── session switching ──────────────────────────────────────────────
// Sequence-guarded: overlapping calls (user clicks + broadcast refreshes) can
// interleave across awaits; only the newest call may touch the DOM.
let switchSeq = 0;
async function switchTo(id) {
  const seq = ++switchSeq;
  activeId = id;
  await api.setActiveSession(id);
  if (seq !== switchSeq) return;
  toolEls.clear(); decks.clear(); stopThinking();
  streamEl = null; streamText = ""; pendingApproval = null;
  const t = await api.getTranscript(id);
  if (seq !== switchSeq) return;
  scroll.innerHTML = "";
  if (!t || !t.length) welcome();
  else for (const ev of t) renderEvent(ev, false);
  $("ctx-meter").classList.add("hidden"); // repopulates from the session's context events
  updateFolder(); syncComposer(); scrollDown();
  input.focus();
}

// Context meter: hidden until 50%, accent-colored from 80%. Click = /compact.
function updateCtxMeter(pct) {
  const el = $("ctx-meter");
  el.classList.toggle("hidden", !(pct >= 50));
  el.classList.toggle("warn", pct >= 80);
  $("ctx-pct").textContent = pct + "%";
}

function updateFolder() {
  const s = activeSession();
  $("folder-name").textContent = baseName(s ? s.workspace : "");
  $("folder-chip").title = s ? s.workspace : "";
}
function folderMenu() {
  if (mpop && mpop.dataset.tag === "folder") { hidePop(); return; } // toggle
  const s = activeSession(); if (!s) return;
  const items = [
    { label: "Change folder…", hint: "pick any folder", onPick: () => api.pickWorkspace(activeId) },
    { label: api.platform === "darwin" ? "Reveal in Finder" : "Show in file manager", hint: prettyPath(s.workspace), onPick: () => api.revealFolder(s.workspace) },
    { label: "🧠 Project memory…", hint: "view & edit what the agent remembers", onPick: () => openMemoryEditor() },
    { label: "📚 Add files to knowledge…", hint: "reference docs for every session here", onPick: async () => { const r = await api.importKnowledge(); if (r.added && r.added.length) addSystem(`📚 Added to project knowledge: ${r.added.join(", ")}`); } },
    { label: "📂 Open knowledge folder", hint: "drop files in directly", onPick: () => api.openKnowledge() },
  ];
  const seen = new Set([s.workspace]);
  for (const o of sessionsCache) {
    if (!o.workspace || seen.has(o.workspace)) continue;
    seen.add(o.workspace);
    items.push({ label: "📁 " + baseName(o.workspace), hint: prettyPath(o.workspace), onPick: async () => { await api.setWorkspacePath(activeId, o.workspace); fileIndex = null; } });
  }
  openMenu(items, $("folder-chip"), "folder");
}
function syncComposer() { const s = activeSession(); const running = s && s.status === "running"; stopBtn.classList.toggle("hidden", !running); }

// ── rail rendering: sessions grouped under their project ───────────
const collapsedProjects = new Set();

// Double-click a title to rename it in place. Enter/blur commits, Esc cancels.
function inlineRename(span, current, commit) {
  const inp = document.createElement("input");
  inp.className = "rename-input";
  inp.value = current;
  span.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    inp.replaceWith(span);
    if (save && v && v !== current) commit(v);
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("click", (e) => e.stopPropagation());
}
function renderSessions(list, act) {
  sessionsCache = list; if (act !== undefined) activeId = act ?? activeId;
  const box = $("session-list"); box.innerHTML = "";
  const groups = new Map(); // pid -> { name, workspace, items }
  for (const s of list) {
    const pid = s.projectId || s.workspace || "?";
    if (!groups.has(pid)) groups.set(pid, { name: s.projectName || baseName(s.workspace), workspace: s.workspace, items: [] });
    groups.get(pid).items.push(s);
  }
  for (const [pid, g] of groups) {
    const closed = collapsedProjects.has(pid);
    const head = document.createElement("div");
    head.className = "pgroup";
    head.innerHTML = `<span class="pcaret">${closed ? "▸" : "▾"}</span><span class="pname">📁 ${esc(g.name)}</span><span class="pcount">${closed ? g.items.length : ""}</span><button class="rail-add padd" title="New session in ${esc(g.name)}">+</button>`;
    head.querySelector(".padd").addEventListener("click", async (e) => {
      e.stopPropagation();
      const s = await api.createSession({ workspace: g.workspace }).catch(() => null);
      if (s) { fileIndex = null; await switchTo(s.id); } else engineNotReady();
    });
    head.addEventListener("click", () => { closed ? collapsedProjects.delete(pid) : collapsedProjects.add(pid); renderSessions(sessionsCache, activeId); });
    head.querySelector(".pname").addEventListener("dblclick", (e) => {
      e.stopPropagation();
      inlineRename(e.currentTarget, g.name, (v) => api.renameProject(pid, v));
    });
    box.appendChild(head);
    if (closed) continue;
    for (const s of g.items) {
      const el = document.createElement("div");
      el.className = "sitem" + (s.id === activeId ? " active" : "");
      el.innerHTML = `<span class="sdot ${s.status}"></span><span class="sinfo"><span class="stitle" title="Double-click to rename">${esc(s.title)}</span></span><span class="sx" title="Close">✕</span>`;
      el.querySelector(".stitle").addEventListener("dblclick", (e) => {
        e.stopPropagation();
        inlineRename(e.currentTarget, s.title, (v) => api.renameSession(s.id, v));
      });
      el.addEventListener("click", (e) => { if (e.target.classList.contains("sx")) { api.removeSession(s.id); return; } if (s.id !== activeId) switchTo(s.id); });
      box.appendChild(el);
    }
  }
  syncComposer(); updateFolder();
}

function renderMcp(servers) {
  currentMcp = servers || [];
  if (!$("modal").classList.contains("hidden")) renderGallery();
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
api.on("sessions:list", (p) => {
  renderSessions(p.sessions, p.activeId);
  // Agent tools can install skills mid-turn; keep the palette current.
  api.listSkills().then((s) => { skillsCache = s || []; }).catch(() => {});
  // The engine usually finishes booting after the page loads; if the pane is
  // still showing the empty boot welcome, swap in the real active session.
  if ($("welcome") && activeId) switchTo(activeId);
});
api.on("mcp:list", (p) => renderMcp(p.servers));
api.on("skills:list", (p) => { skillsCache = p.skills || []; });
api.on("gateway:status", (s) => {
  const d = $("gw-dot");
  d.className = "s-dot " + (s.state === "ready" ? "ok" : s.state === "error" ? "err" : "boot");
  $("gw-label").textContent = s.state === "ready" ? "ready" : s.state === "error" ? "engine error" : "starting…";
  // The engine usually finishes booting *after* this page loads, so the initial
  // model fetch comes back empty. Fill the picker in once it's actually up.
  if (s.state === "ready") populateModels();
});

// ── @-mentions ─────────────────────────────────────────────────────
function renderChips() {
  const box = $("chips"); box.innerHTML = "";
  mentions.forEach((p) => { const c = document.createElement("span"); c.className = "chip"; c.innerHTML = `@${esc(p)} <span class="x">✕</span>`; c.querySelector(".x").addEventListener("click", () => { mentions.delete(p); renderChips(); }); box.appendChild(c); });
  pastedImages.forEach((url, i) => { const c = document.createElement("span"); c.className = "chip imgchip"; c.innerHTML = `<img src="${url}" class="imgthumb"/> image <span class="x">✕</span>`; c.querySelector(".x").addEventListener("click", () => { pastedImages.splice(i, 1); renderChips(); }); box.appendChild(c); });
  attachedFiles.forEach((f, i) => { const c = document.createElement("span"); c.className = "chip"; c.innerHTML = `📄 ${esc(f.name)} <span class="x">✕</span>`; c.querySelector(".x").addEventListener("click", () => { attachedFiles.splice(i, 1); renderChips(); }); box.appendChild(c); });
}

// ── attachments: 📎 button + drag & drop ───────────────────────────
// Images become vision input; text files ride along as context blocks.
const MAX_ATTACH = 8, MAX_FILE_BYTES = 400_000, MAX_FILE_CHARS = 100_000;
function addAttachment(file) {
  if (pastedImages.length + attachedFiles.length >= MAX_ATTACH) { addSystem(`Attachment limit is ${MAX_ATTACH} per message.`); return; }
  if (file.type && file.type.startsWith("image/")) {
    const r = new FileReader();
    r.onload = () => { pastedImages.push(r.result); renderChips(); };
    r.readAsDataURL(file);
    return;
  }
  if (file.size > MAX_FILE_BYTES) { addSystem(`"${file.name}" is too large to attach (max ${Math.round(MAX_FILE_BYTES / 1000)} KB). Add it to project knowledge instead (folder menu).`); return; }
  const r = new FileReader();
  r.onload = () => {
    const text = String(r.result || "");
    if (text.includes("\u0000")) { addSystem(`"${file.name}" looks binary — attach images or text files.`); return; }
    attachedFiles.push({ name: file.name, content: text.slice(0, MAX_FILE_CHARS) });
    renderChips();
  };
  r.readAsText(file);
}
function handleFiles(list) { for (const f of list || []) addAttachment(f); input.focus(); }
$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });
let dragDepth = 0;
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragenter", (e) => { e.preventDefault(); if (++dragDepth === 1 && e.dataTransfer?.types?.includes("Files")) document.body.classList.add("dropping"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dropping"); } });
window.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove("dropping"); handleFiles(e.dataTransfer.files); });
// paste an image into the composer
input.addEventListener("paste", (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      const file = it.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => { pastedImages.push(reader.result); renderChips(); };
      reader.readAsDataURL(file);
      e.preventDefault();
    }
  }
});
async function buildIndex() { if (fileIndex) return fileIndex; const out = []; async function walk(rel, d) { if (d > 4 || out.length > 2000) return; const res = await api.listDir(rel); if (!res.entries) return; for (const e of res.entries) { if (e.type === "file") out.push(e.path); else await walk(e.path, d + 1); } } await walk(".", 0); return (fileIndex = out); }
// One popup component for @-files, /-commands, and the folder menu.
// items: [{ label, hint, onPick }]
let mpop = null, mSel = 0, mItems = [];
function openMenu(items, anchorEl, tag) {
  hidePop();
  if (!items.length) return;
  mItems = items; mSel = 0;
  mpop = document.createElement("div"); mpop.className = "mpop"; mpop.dataset.tag = tag || "";
  items.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "mpitem" + (i === 0 ? " sel" : "");
    el.innerHTML = `<span>${esc(it.label)}</span><span class="mp">${esc(it.hint || "")}</span>`;
    el.addEventListener("mousedown", (e) => { e.preventDefault(); mSel = i; pickSel(); });
    mpop.appendChild(el);
  });
  document.body.appendChild(mpop);
  const r = (anchorEl || $("inputbox")).getBoundingClientRect();
  const w = Math.max(260, Math.min(r.width, 480));
  mpop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  mpop.style.bottom = window.innerHeight - r.top + 6 + "px";
  mpop.style.width = w + "px";
}
function hidePop() { if (mpop) mpop.remove(); mpop = null; mItems = []; }
function moveSel(d) { if (!mpop) return; const items = [...mpop.querySelectorAll(".mpitem")]; items[mSel]?.classList.remove("sel"); mSel = (mSel + d + items.length) % items.length; items[mSel]?.classList.add("sel"); items[mSel]?.scrollIntoView({ block: "nearest" }); }
function pickSel() { const it = mItems[mSel]; hidePop(); if (it) it.onPick(); }
document.addEventListener("mousedown", (e) => { if (mpop && !mpop.contains(e.target) && e.target !== input) hidePop(); });

async function showFilePop(q) {
  const idx = await buildIndex();
  const matches = idx.filter((p) => p.toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  openMenu(matches.map((p) => ({
    label: p.split("/").pop(), hint: p,
    onPick: () => { mentions.add(p); renderChips(); input.value = input.value.replace(/@[^\s]*$/, "").trimEnd(); input.focus(); },
  })));
}
function showCommandPop(q) {
  const ql = q.toLowerCase();
  const matches = allCommands()
    .filter((c) => c.name.includes(ql))
    .sort((a, b) => (a.name.startsWith(ql) ? 0 : 1) - (b.name.startsWith(ql) ? 0 : 1))
    .slice(0, 20);
  openMenu(matches.map((c) => ({
    label: "/" + c.name + (c.args ? " " + c.args : ""), hint: c.desc,
    onPick: () => applyCommand(c),
  })));
}
// Commands that take arguments complete into the input; the rest run immediately.
function applyCommand(c) {
  input.value = ""; grow();
  if (c.args) { input.value = "/" + c.name + " "; grow(); input.focus(); return; }
  const w = $("welcome"); if (w) w.remove();
  c.run("");
}

// ── composer ───────────────────────────────────────────────────────
function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
input.addEventListener("input", () => {
  grow();
  const sm = input.value.match(/^\/([a-z0-9:_-]*)$/i);
  if (sm) { showCommandPop(sm[1]); return; }
  const m = input.value.match(/@([^\s]*)$/);
  if (m) showFilePop(m[1]); else hidePop();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleApproval(); return; }
  if (pendingApproval && !input.value.trim() && (e.key === "y" || e.key === "n")) { e.preventDefault(); pendingApproval(e.key === "y"); return; }
  if (mpop) { if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); return; } if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); return; } if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSel(); return; } if (e.key === "Escape") { hidePop(); return; } }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === "Escape") api.stopSession(activeId);
});
$("approval-toggle").addEventListener("click", cycleApproval);
async function send() {
  const text = input.value.trim();
  if ((!text && !mentions.size && !pastedImages.length) || !activeId) return;
  if (text.startsWith("/")) { input.value = ""; grow(); hidePop(); handleSlash(text); return; }
  let full = text; if (mentions.size) full = `${text}\n\nReferenced files: ${[...mentions].map((p) => "@" + p).join(", ")}`;
  // Attached text files ride along for the model; the transcript shows only a label.
  let label = null;
  if (attachedFiles.length) {
    label = text + `  📎 ${attachedFiles.map((f) => f.name).join(", ")}`;
    full += "\n\n" + attachedFiles.map((f) => `## Attached file: ${f.name}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n");
  }
  const images = pastedImages.slice();
  const w = $("welcome"); if (w) w.remove();
  input.value = ""; mentions.clear(); pastedImages.length = 0; attachedFiles.length = 0; renderChips(); grow(); hidePop();
  await api.sendMessage(activeId, full, images, label);
}

// ── slash commands ─────────────────────────────────────────────────
function engineNotReady() { addSystem("The engine is still starting (see the status dot, bottom-left) — try again in a few seconds."); }
async function newSession(title) {
  const ws = activeSession()?.workspace;
  const s = await api.createSession({ ...(title && { title }), ...(ws && { workspace: ws }) }).catch(() => null);
  if (!s) { engineNotReady(); return null; }
  fileIndex = null; await switchTo(s.id);
  return s;
}
async function newProject() {
  const s = await api.newProject().catch(() => null);
  if (s && s.error) { engineNotReady(); return; }
  if (s) { fileIndex = null; await switchTo(s.id); }
}
const COMMANDS = [
  { name: "help", desc: "Show all commands", run: () => addSystem("commands:  " + allCommands().map((c) => "/" + c.name + (c.args ? " " + c.args : "")).join("  ")) },
  { name: "clear", desc: "Start a fresh session", run: () => newSession() },
  { name: "new", desc: "Start a fresh session", run: () => newSession() },
  { name: "project", desc: "New project — pick a folder", run: () => newProject() },
  { name: "memory", desc: "View & edit what the agent remembers", run: () => openMemoryEditor() },
  { name: "knowledge", desc: "Open this project's knowledge folder", run: () => api.openKnowledge() },
  { name: "folder", alias: "cwd", desc: "Change the working folder", run: () => api.pickWorkspace(activeId) },
  { name: "model", args: "<name>", desc: "Switch AI model", run: (arg) => { if (arg) { $("model").value = arg; api.setModel(arg); addSystem("model → " + arg); } else addSystem("usage: /model <name>"); } },
  { name: "undo", desc: "Undo last turn's file changes", run: () => api.undo(activeId) },
  { name: "compact", desc: "Summarize older context to free space", run: () => api.compactSession(activeId) },
  { name: "skills", desc: "Open the skills folder", run: () => api.openSkills() },
  { name: "skill:new", args: "<name>", desc: "Scaffold a new skill", run: async (arg) => { const r = await api.newSkill(arg); addSystem(r.error ? "✗ " + r.error : `Skill "${r.name}" created — edit its SKILL.md, then use /${r.name}`); } },
  { name: "skill:install", args: "<url|owner/repo|folder>", desc: "Install skills from git or a folder", run: async (arg) => {
    addSystem("Installing skills from " + arg + "…");
    const r = await api.installSkills(arg);
    addSystem(r.error ? "✗ " + r.error : (r.installed.length ? `✓ Installed: ${r.installed.map((n) => "/" + n).join("  ")}` : "No SKILL.md directories found there."));
  } },
  { name: "approve", args: "auto|ask|edits|plan", desc: "Set approval mode (Shift+Tab cycles)", run: (arg) => setApproval(arg) },
];
function allCommands() {
  const base = [...COMMANDS, ...RECIPES.map((r) => ({ name: "recipe:" + r.slug, desc: r.desc, run: () => runRecipe(r) }))];
  const taken = new Set(base.map((c) => c.name));
  // Installed skills become slash commands; built-ins win name collisions.
  const skillCmds = skillsCache.filter((s) => !taken.has(s.name)).map((s) => ({
    name: s.name, args: "<task>", desc: (s.description || "skill") + " · skill",
    run: (arg) => {
      const w = $("welcome"); if (w) w.remove();
      api.sendMessage(activeId, `Use your "${s.name}" skill${arg ? ` for this task: ${arg}` : "."}`);
    },
  }));
  return [...base, ...skillCmds];
}
function handleSlash(text) {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const w = $("welcome"); if (w) w.remove();
  const key = (cmd || "").toLowerCase();
  const c = allCommands().find((x) => x.name === key || x.alias === key);
  if (c) c.run(arg);
  else addSystem("unknown command: /" + cmd + "  (try /help)");
}

// Approval modes, cycled with Shift+Tab (like Claude Code) or by clicking.
const MODES = [
  { id: "auto", label: "⚡ auto", desc: "auto: runs everything without asking" },
  { id: "ask", label: "🛡 ask", desc: "ask: approve commands & file changes" },
  { id: "edits", label: "✏ edits", desc: "accept edits: file changes run, commands still ask" },
  { id: "plan", label: "⏸ plan", desc: "plan: read-only — explores and proposes a plan" },
];
function setApproval(mode, { announce = true } = {}) {
  const m = MODES.find((x) => x.id === mode) || MODES[0];
  approvalMode = m.id;
  api.setApproval(approvalMode);
  const btn = $("approval-toggle");
  btn.textContent = m.label;
  btn.title = m.desc + " — Shift+Tab to cycle";
  btn.classList.toggle("on", m.id !== "auto");
  if (announce) addSystem(m.desc);
}
function cycleApproval() {
  const i = MODES.findIndex((x) => x.id === approvalMode);
  setApproval(MODES[(i + 1) % MODES.length].id);
}
stopBtn.addEventListener("click", () => api.stopSession(activeId));
document.addEventListener("click", (e) => { const t = e.target.closest(".tip"); if (t) { input.value = t.dataset.p; grow(); input.focus(); } });

// ── memory editor ──────────────────────────────────────────────────
let memScope = "project";
async function loadMemoryEditor(scope) {
  memScope = scope;
  $("mem-tab-project").classList.toggle("on", scope === "project");
  $("mem-tab-global").classList.toggle("on", scope === "global");
  const r = await api.readMemory(scope);
  $("mem-text").value = r.content || "";
}
function openMemoryEditor() { $("memory-modal").classList.remove("hidden"); loadMemoryEditor("project"); }
async function saveMemoryEditor() { await api.writeMemory(memScope, $("mem-text").value); }
$("mem-tab-project").addEventListener("click", async () => { await saveMemoryEditor(); loadMemoryEditor("project"); });
$("mem-tab-global").addEventListener("click", async () => { await saveMemoryEditor(); loadMemoryEditor("global"); });
$("mem-save").addEventListener("click", async () => { await saveMemoryEditor(); $("memory-modal").classList.add("hidden"); addSystem("🧠 Memory saved."); });
$("mem-cancel").addEventListener("click", () => $("memory-modal").classList.add("hidden"));
$("mem-reveal").addEventListener("click", () => api.openMemory(memScope === "global" ? "global" : undefined));
$("memory-modal").addEventListener("click", (e) => { if (e.target.id === "memory-modal") $("memory-modal").classList.add("hidden"); });

// ── new session / cwd / model / dashboard ──────────────────────────
$("new-project").addEventListener("click", () => newProject());
$("folder-chip").addEventListener("click", folderMenu);
$("ctx-meter").addEventListener("click", () => api.compactSession(activeId));
$("dashboard").addEventListener("click", () => api.openDashboard());
$("model").addEventListener("change", (e) => api.setModel(e.target.value));

async function populateModels(current) {
  const models = await api.listModels();
  if (!models || !models.length) return;
  const sel = $("model");
  const chosen = current || sel.value || "auto";
  sel.innerHTML = '<option value="auto">auto (free)</option>';
  models.filter((m) => m !== "auto").sort().forEach((m) => { const o = document.createElement("option"); o.value = m; o.textContent = m; sel.appendChild(o); });
  sel.value = chosen === "auto" || models.includes(chosen) ? chosen : "auto";
}

// ── MCP gallery + modal ────────────────────────────────────────────
const MCP_GALLERY = [
  { name: "filesystem", icon: "📁", desc: "Read & write files in a folder", cmd: "npx", args: "-y @modelcontextprotocol/server-filesystem ." },
  { name: "memory", icon: "🧠", desc: "Persistent knowledge-graph memory", cmd: "npx", args: "-y @modelcontextprotocol/server-memory" },
  { name: "sequential-thinking", icon: "🔗", desc: "Structured step-by-step reasoning", cmd: "npx", args: "-y @modelcontextprotocol/server-sequential-thinking" },
  { name: "everything", icon: "✨", desc: "Reference server — every MCP feature", cmd: "npx", args: "-y @modelcontextprotocol/server-everything" },
  { name: "github", icon: "🐙", desc: "Repos, issues, PRs (needs token)", cmd: "npx", args: "-y @modelcontextprotocol/server-github", env: "GITHUB_PERSONAL_ACCESS_TOKEN=", needsCfg: true },
  { name: "puppeteer", icon: "🎭", desc: "Drive a headless browser", cmd: "npx", args: "-y @modelcontextprotocol/server-puppeteer" },
  { name: "postgres", icon: "🐘", desc: "Query a Postgres database", cmd: "npx", args: "-y @modelcontextprotocol/server-postgres postgresql://localhost/db", needsCfg: true },
  { name: "brave-search", icon: "🔎", desc: "Web search (needs API key)", cmd: "npx", args: "-y @modelcontextprotocol/server-brave-search", env: "BRAVE_API_KEY=", needsCfg: true },
];
function renderGallery() {
  const g = $("gallery"); g.innerHTML = "";
  const connected = new Set(currentMcp.map((s) => s.name));
  MCP_GALLERY.forEach((it) => {
    const el = document.createElement("div");
    const on = connected.has(it.name);
    el.className = "gcard" + (on ? " gcard-on" : "");
    el.innerHTML = `<div class="gc-top"><span class="gc-ic">${it.icon}</span><span class="gc-name">${esc(it.name)}</span></div><div class="gc-desc">${esc(it.desc)}</div><div class="gc-act">${on ? "✓ connected" : it.needsCfg ? "configure →" : "+ connect"}</div>`;
    el.addEventListener("click", () => {
      if (on) return;
      $("m-name").value = it.name; $("m-cmd").value = it.cmd; $("m-args").value = it.args; $("m-env").value = it.env || "";
      if (it.needsCfg) { $("m-env").focus(); }   // let the user paste a token / edit the connection
      else { addFromForm(); }                    // one-click for no-config servers
    });
    g.appendChild(el);
  });
}
function openModal() { renderGallery(); $("modal").classList.remove("hidden"); }
function closeModal() { $("modal").classList.add("hidden"); $("m-name").value = ""; $("m-cmd").value = ""; $("m-args").value = ""; $("m-env").value = ""; }
async function addFromForm() {
  const name = $("m-name").value.trim(); const command = $("m-cmd").value.trim(); const argsStr = $("m-args").value.trim();
  if (!name || !command) return;
  const env = {};
  ($("m-env").value || "").split("\n").forEach((l) => { const i = l.indexOf("="); if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  const conf = { command, args: argsStr ? argsStr.split(/\s+/) : [] };
  if (Object.keys(env).length) conf.env = env;
  closeModal();
  await api.addMcp(name, conf);
}
$("add-mcp").addEventListener("click", openModal);
$("m-cancel").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
$("m-add").addEventListener("click", addFromForm);

// ── Recipes ────────────────────────────────────────────────────────
const RECIPES = [
  { slug: "tour", name: "Tour the codebase", icon: "🧭", desc: "Map the architecture and key files", prompt: "Give me a guided tour of this codebase: list the top-level structure, explain the architecture, and point out the entry points and the most important files." },
  { slug: "tests", name: "Write tests", icon: "🧪", desc: "Add tests across modules in parallel", prompt: "Add comprehensive tests for this project. Identify the main modules, then use spawn_subagents to write tests for each module in parallel. Finally run the test suite and report results." },
  { slug: "bughunt", name: "Find & fix bugs", icon: "🐛", desc: "Hunt bugs, fan out fixes", prompt: "Do a bug hunt across this codebase. Use spawn_subagents to inspect different areas in parallel, collect the issues, then fix the real ones and summarize the changes." },
  { slug: "refactor", name: "Refactor pass", icon: "♻️", desc: "Safe cleanups and simplifications", prompt: "Review this codebase for refactoring opportunities (duplication, dead code, unclear names, oversized functions). Apply the safe, high-value improvements and summarize what changed." },
  { slug: "docs", name: "Generate docs", icon: "📚", desc: "README + inline documentation", prompt: "Generate documentation for this project: a clear README with overview, setup, and usage, plus concise inline comments where the code is non-obvious." },
  { slug: "feature", name: "Add a feature", icon: "✨", desc: "Scaffold a new feature end-to-end", prompt: "I want to add a new feature. First explore the codebase to understand the conventions, then propose a short plan, then implement it with tests. Ask me for the feature description first." },
  { slug: "debug", name: "Explain this error", icon: "🚨", desc: "Diagnose from logs/stack traces", prompt: "Help me debug an error. Ask me to paste the error or point you at the failing command, then investigate the root cause in the code and propose a fix." },
  { slug: "perf", name: "Speed it up", icon: "⚡", desc: "Find and fix performance issues", prompt: "Profile this project for performance problems: look for slow paths, N+1 patterns, unnecessary work, and heavy dependencies. Suggest and apply safe optimizations." },
];
async function runRecipe(r) {
  $("recipes-modal").classList.add("hidden");
  const s = await api.createSession({ title: r.name });
  if (s) { fileIndex = null; await switchTo(s.id); await api.sendMessage(s.id, r.prompt); }
}
function renderRecipes() {
  const g = $("recipes-grid"); g.innerHTML = "";
  RECIPES.forEach((r) => {
    const el = document.createElement("div");
    el.className = "gcard";
    el.innerHTML = `<div class="gc-top"><span class="gc-ic">${r.icon}</span><span class="gc-name">${esc(r.name)}</span></div><div class="gc-desc">${esc(r.desc)}</div><div class="gc-act">run →</div>`;
    el.addEventListener("click", () => runRecipe(r));
    g.appendChild(el);
  });
}
$("recipes-btn").addEventListener("click", () => { renderRecipes(); $("recipes-modal").classList.remove("hidden"); });
$("rec-cancel").addEventListener("click", () => $("recipes-modal").classList.add("hidden"));
$("recipes-modal").addEventListener("click", (e) => { if (e.target.id === "recipes-modal") $("recipes-modal").classList.add("hidden"); });

// ── init ───────────────────────────────────────────────────────────
(async () => {
  const st = await api.getState();
  if (st) {
    if (st.model) $("model").value = st.model;
    if (st.approval) setApproval(st.approval, { announce: false });
    if (st.mcp) renderMcp(st.mcp);
    populateModels(st.model);
    if (st.sessions && st.sessions.length) { renderSessions(st.sessions, st.activeId); await switchTo(st.activeId || st.sessions[0].id); }
    else welcome();
    api.listSkills().then((s) => { skillsCache = s || []; }).catch(() => {});
  } else welcome();
  input.focus();
})();
