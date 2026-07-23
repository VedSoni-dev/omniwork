"use strict";
// Falls back to a no-op stub when the Electron preload bridge is absent
// (e.g. opened in a plain browser for design preview), so the UI still renders.
const stub = {
  _demo: true,
  sendMessage: async () => {}, stop: async () => {}, newSession: async () => {},
  pickWorkspace: async () => {}, listDir: async () => ({ root: null, entries: [] }),
  readFile: async () => ({ content: "" }), getState: async () => ({ model: "auto" }),
  setModel: async () => {}, openDashboard: async () => {}, on: () => () => {},
};
const api = window.omniwork || stub;
const $ = (id) => document.getElementById(id);

const transcript = $("transcript");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const statusHint = $("status-hint");
const treeEl = $("tree");

let busy = false;
let thinkingEl = null;
let hasWorkspace = false;
const toolEls = new Map();
const openTabs = new Map(); // path -> {tabBtn}
const mentions = new Set();
let fileIndex = null; // cached flat list for @-search

// ── util ───────────────────────────────────────────────────────────
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function scrollDown() { transcript.scrollTop = transcript.scrollHeight; }

function iconFor(name, isDir) {
  if (isDir) return "▸";
  const ext = name.split(".").pop().toLowerCase();
  const map = { js: "🟨", ts: "🟦", jsx: "⚛", tsx: "⚛", json: "◍", md: "▮", css: "◈", html: "◇", py: "🐍", go: "◎", rs: "◆", sh: "▷", yml: "⚙", yaml: "⚙", lock: "🔒", txt: "▤", png: "▦", svg: "◇" };
  return map[ext] || "▪";
}

function renderMarkdown(text) {
  const parts = text.split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const body = parts[i].replace(/^[a-zA-Z0-9]*\n/, "");
      html += `<pre><code>${esc(body)}</code></pre>`;
    } else {
      html += esc(parts[i]).replace(/`([^`]+)`/g, "<code>$1</code>");
    }
  }
  return html;
}

// ── file tree ──────────────────────────────────────────────────────
async function loadTree() {
  const res = await api.listDir(".");
  treeEl.innerHTML = "";
  if (!res.root) {
    treeEl.innerHTML = `<div class="tree-empty"><p>No folder open</p><button id="open-folder-3" class="btn btn-outline btn-sm">Open folder…</button></div>`;
    $("open-folder-3").addEventListener("click", pickFolder);
    hasWorkspace = false;
    return;
  }
  hasWorkspace = true;
  fileIndex = null;
  for (const entry of res.entries) treeEl.appendChild(renderNode(entry, 0));
}

function renderNode(entry) {
  const node = document.createElement("div");
  node.className = "node";
  const row = document.createElement("div");
  row.className = "node-row";
  const isDir = entry.type === "dir";
  row.innerHTML =
    `<span class="node-caret">${isDir ? "›" : ""}</span>` +
    `<span class="node-ic">${iconFor(entry.name, isDir)}</span>` +
    `<span class="node-name">${esc(entry.name)}</span>`;
  node.appendChild(row);

  if (isDir) {
    const children = document.createElement("div");
    children.className = "node-children";
    node.appendChild(children);
    let loaded = false;
    row.addEventListener("click", async () => {
      node.classList.toggle("open");
      if (!loaded && node.classList.contains("open")) {
        loaded = true;
        const res = await api.listDir(entry.path);
        for (const c of res.entries) children.appendChild(renderNode(c));
      }
    });
  } else {
    row.addEventListener("click", () => openFile(entry.path, row));
  }
  return node;
}

// ── file viewer + tabs ─────────────────────────────────────────────
function showView(which) {
  $("view-chat").classList.toggle("hidden", which !== "chat");
  $("view-file").classList.toggle("hidden", which !== "file");
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("tab-active"));
  if (which === "chat") $("tab-chat").classList.add("tab-active");
}

async function openFile(relPath, rowEl) {
  document.querySelectorAll(".node-row.active").forEach((r) => r.classList.remove("active"));
  if (rowEl) rowEl.classList.add("active");
  const res = await api.readFile(relPath);
  const base = relPath.split("/").pop();
  $("file-name").textContent = relPath;
  const code = $("file-content").querySelector("code") || $("file-content");
  $("file-content").textContent = res.error ? `// ${res.error}` : res.content;
  $("mention-file").onclick = () => { addMention(relPath); showView("chat"); input.focus(); };

  // tab
  let tab = openTabs.get(relPath);
  if (!tab) {
    tab = document.createElement("button");
    tab.className = "tab";
    tab.innerHTML = `<span class="tab-ic">${iconFor(base, false)}</span> ${esc(base)} <span class="tab-close">×</span>`;
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab-close")) { closeTab(relPath); return; }
      openFile(relPath);
    });
    $("tabs").appendChild(tab);
    openTabs.set(relPath, tab);
  }
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("tab-active"));
  tab.classList.add("tab-active");
  $("view-chat").classList.add("hidden");
  $("view-file").classList.remove("hidden");
}

function closeTab(relPath) {
  const tab = openTabs.get(relPath);
  if (tab) tab.remove();
  openTabs.delete(relPath);
  showView("chat");
}

$("tab-chat").addEventListener("click", () => showView("chat"));

// ── @-mentions ─────────────────────────────────────────────────────
function renderMentions() {
  const box = $("mentions");
  box.innerHTML = "";
  mentions.forEach((p) => {
    const chip = document.createElement("span");
    chip.className = "mention";
    chip.innerHTML = `@${esc(p)} <span class="x">×</span>`;
    chip.querySelector(".x").addEventListener("click", () => { mentions.delete(p); renderMentions(); });
    box.appendChild(chip);
  });
}
function addMention(p) { mentions.add(p); renderMentions(); }

async function buildFileIndex() {
  if (fileIndex) return fileIndex;
  const out = [];
  async function walk(rel, depth) {
    if (depth > 4) return;
    const res = await api.listDir(rel);
    if (!res.entries) return;
    for (const e of res.entries) {
      if (e.type === "file") out.push(e.path);
      else if (depth < 4 && out.length < 2000) await walk(e.path, depth + 1);
    }
  }
  await walk(".", 0);
  fileIndex = out;
  return out;
}

let mentionPop = null;
async function showMentionPop(query) {
  const idx = await buildFileIndex();
  const q = query.toLowerCase();
  const matches = idx.filter((p) => p.toLowerCase().includes(q)).slice(0, 30);
  hideMentionPop();
  if (!matches.length) return;
  mentionPop = document.createElement("div");
  mentionPop.className = "mention-pop";
  matches.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "mention-item" + (i === 0 ? " sel" : "");
    const base = p.split("/").pop();
    item.innerHTML = `<span>${esc(base)}</span> <span class="p">${esc(p)}</span>`;
    item.addEventListener("mousedown", (e) => { e.preventDefault(); pickMention(p); });
    mentionPop.appendChild(item);
  });
  const box = $("composer-box");
  const r = box.getBoundingClientRect();
  document.body.appendChild(mentionPop);
  mentionPop.style.left = r.left + "px";
  mentionPop.style.bottom = window.innerHeight - r.top + 6 + "px";
  mentionPop.style.width = r.width + "px";
}
function hideMentionPop() { if (mentionPop) { mentionPop.remove(); mentionPop = null; } }
function pickMention(p) {
  addMention(p);
  input.value = input.value.replace(/@[^\s]*$/, "").trimEnd();
  hideMentionPop();
  input.focus();
}

// ── rendering agent output ─────────────────────────────────────────
function clearHero() { const h = $("hero"); if (h) h.remove(); }
function removeThinking() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }

function addMessage(role, content) {
  clearHero(); removeThinking();
  const row = document.createElement("div");
  row.className = "row";
  const isUser = role === "user";
  row.innerHTML =
    `<div class="msg"><div class="avatar ${isUser ? "user" : "assistant"}">${isUser ? "U" : "◇"}</div>` +
    `<div class="msg-body"><div class="msg-role">${isUser ? "You" : "OmniWork"}</div>` +
    `<div class="msg-content">${renderMarkdown(content)}</div></div></div>`;
  transcript.appendChild(row);
  scrollDown();
}

function diffHtml(oldS, newS) {
  const o = (oldS || "").split("\n");
  const n = (newS || "").split("\n");
  let html = "";
  o.forEach((l) => (html += `<div class="del">- ${esc(l)}</div>`));
  n.forEach((l) => (html += `<div class="add">+ ${esc(l)}</div>`));
  return html;
}

function toolMeta(name, args) {
  const badges = { run_command: "run", read_file: "read", write_file: "write", edit_file: "edit", list_dir: "ls" };
  let arg = "";
  if (name === "run_command") arg = args.command || "";
  else if (args.path) arg = args.path;
  return { badge: badges[name] || name, arg };
}

function addToolCard(id, name, args) {
  clearHero(); removeThinking();
  const { badge, arg } = toolMeta(name, args);
  const card = document.createElement("div");
  card.className = "tool";
  const isDiff = name === "edit_file" || name === "write_file";
  card.innerHTML =
    `<div class="tool-card"><div class="tool-head">` +
    `<span class="tool-caret">›</span><span class="tool-badge">${badge}</span>` +
    `<span class="tool-arg">${esc(arg)}</span>` +
    `<span class="tool-status"><span class="spinner"></span></span></div>` +
    `<div class="tool-out"></div></div>`;
  const cardInner = card.querySelector(".tool-card");
  card.querySelector(".tool-head").addEventListener("click", () => cardInner.classList.toggle("open"));
  const out = card.querySelector(".tool-out");
  if (name === "edit_file") { out.innerHTML = diffHtml(args.old_string, args.new_string); cardInner.classList.add("open"); }
  else if (name === "write_file") { out.innerHTML = `<div class="add">+ ${esc(args.path || "")}</div>` + esc((args.content || "").slice(0, 4000)); }
  transcript.appendChild(card);
  toolEls.set(id, { card, cardInner, out, status: card.querySelector(".tool-status"), isDiff });
  scrollDown();
}

function streamTool(id, chunk) { const el = toolEls.get(id); if (el && !el.isDiff) el.out.textContent += chunk; }
function finishToolCard(id, result) {
  const el = toolEls.get(id);
  if (!el) return;
  el.status.innerHTML = `<span class="tool-check">✓</span>`;
  if (!el.isDiff && !el.out.textContent) el.out.textContent = result;
  scrollDown();
}

function showThinking() {
  removeThinking();
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML = `<span class="spinner"></span> Working…`;
  transcript.appendChild(thinkingEl);
  scrollDown();
}
function showError(msg) {
  removeThinking();
  const el = document.createElement("div");
  el.className = "err";
  el.innerHTML = `<div class="err-in">⚠ ${esc(msg)}</div>`;
  transcript.appendChild(el);
  scrollDown();
}

function setBusy(v) {
  busy = v;
  sendBtn.classList.toggle("hidden", v);
  stopBtn.classList.toggle("hidden", !v);
  statusHint.textContent = v ? "Working…" : "Ready";
}

api.on("agent:event", (ev) => {
  switch (ev.type) {
    case "thinking": showThinking(); break;
    case "assistant": addMessage("assistant", ev.content); break;
    case "tool_call": addToolCard(ev.id, ev.name, ev.args); break;
    case "tool_stream": streamTool(ev.id, ev.chunk); break;
    case "tool_result": finishToolCard(ev.id, ev.result); refreshTreeSoon(); break;
    case "error": showError(ev.message); setBusy(false); break;
    case "aborted": removeThinking(); setBusy(false); break;
    case "done": removeThinking(); setBusy(false); refreshTreeSoon(); break;
  }
});

let refreshTimer = null;
function refreshTreeSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(loadTree, 600); }

api.on("gateway:status", (s) => {
  const dot = $("gateway-dot");
  dot.className = "dot " + (s.state === "ready" ? "dot-ok" : s.state === "error" ? "dot-err" : "dot-boot");
  $("gateway-label").textContent =
    s.state === "ready" ? "Engine ready" : s.state === "error" ? "Engine error" : "Starting engine…";
});

api.on("workspace:changed", (w) => {
  $("ws-path").textContent = w.path || "no workspace";
  loadTree();
});

// ── composer ───────────────────────────────────────────────────────
function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 220) + "px"; }
input.addEventListener("input", () => {
  autoGrow();
  const m = input.value.match(/@([^\s]*)$/);
  if (m) showMentionPop(m[1]); else hideMentionPop();
});

async function send() {
  const text = input.value.trim();
  if ((!text && !mentions.size) || busy) return;
  let full = text;
  if (mentions.size) {
    const list = [...mentions].map((p) => `@${p}`).join(", ");
    full = `${text}\n\nReferenced files: ${list}`;
  }
  addMessage("user", text + (mentions.size ? "\n" + [...mentions].map((p) => "📎 " + p).join("  ") : ""));
  input.value = ""; mentions.clear(); renderMentions(); autoGrow(); hideMentionPop();
  showView("chat");
  setBusy(true);
  await api.sendMessage(full);
}

sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => api.stop());
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === "Escape") hideMentionPop();
});
document.addEventListener("click", (e) => {
  const s = e.target.closest(".suggest");
  if (s) { input.value = s.dataset.prompt; autoGrow(); input.focus(); }
});

// ── wiring ─────────────────────────────────────────────────────────
async function pickFolder() { await api.pickWorkspace(); }
$("open-folder").addEventListener("click", pickFolder);
$("open-folder-2")?.addEventListener("click", pickFolder);
$("hero-open").addEventListener("click", pickFolder);
$("refresh-tree").addEventListener("click", loadTree);
$("new-session").addEventListener("click", async () => { await api.newSession(); transcript.innerHTML = ""; location.reload(); });
$("open-dashboard").addEventListener("click", () => api.openDashboard());
$("model-select").addEventListener("change", (e) => api.setModel(e.target.value));

// ── init ───────────────────────────────────────────────────────────
(async () => {
  const st = await api.getState();
  if (st) {
    if (st.workspace) $("ws-path").textContent = st.workspace;
    if (st.model) $("model-select").value = st.model;
  }
  await loadTree();
})();
