"use strict";
const stub = {
  sendMessage: async () => {}, stop: async () => {}, newSession: async () => {},
  pickWorkspace: async () => {}, listDir: async () => ({ root: null, entries: [] }),
  readFile: async () => ({ content: "" }), getState: async () => ({ model: "auto" }),
  setModel: async () => {}, openDashboard: async () => {}, on: () => () => {},
};
const api = window.omniwork || stub;
const $ = (id) => document.getElementById(id);

const scroll = $("scroll");
const input = $("input");
const stopBtn = $("stop");

let busy = false;
let thinkingEl = null, thinkTimer = null;
const toolEls = new Map();
const mentions = new Set();
let fileIndex = null;
let cwd = null;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const scrollDown = () => (scroll.scrollTop = scroll.scrollHeight);
const clearWelcome = () => { const w = $("welcome"); if (w) w.remove(); };

function md(text) {
  const parts = text.split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) html += `<pre><code>${esc(parts[i].replace(/^[a-zA-Z0-9]*\n/, ""))}</code></pre>`;
    else html += esc(parts[i]).replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  return html;
}

// ── transcript ─────────────────────────────────────────────────────
function addUser(text) {
  clearWelcome(); stopThinking();
  const el = document.createElement("div");
  el.className = "blk user";
  el.innerHTML = `<span class="caret">&gt;</span><span class="utext">${esc(text)}</span>`;
  scroll.appendChild(el); scrollDown();
}
function addAssistant(text) {
  clearWelcome(); stopThinking();
  const el = document.createElement("div");
  el.className = "blk assistant";
  el.innerHTML = md(text);
  scroll.appendChild(el); scrollDown();
}
function addError(msg) {
  stopThinking();
  const el = document.createElement("div");
  el.className = "errline";
  el.textContent = "✗ " + msg;
  scroll.appendChild(el); scrollDown();
}

function diffHtml(oldS, newS) {
  let html = "";
  (oldS || "").split("\n").forEach((l) => (html += `<span class="del">- ${esc(l)}</span>\n`));
  (newS || "").split("\n").forEach((l) => (html += `<span class="add">+ ${esc(l)}</span>\n`));
  return html;
}
function toolTitle(name, args) {
  const label = { run_command: "Bash", read_file: "Read", write_file: "Write", edit_file: "Edit", list_dir: "List" }[name] || name;
  let a = "";
  if (name === "run_command") a = args.command || "";
  else if (args.path) a = args.path;
  return { label, a };
}

function addToolCard(id, name, args) {
  clearWelcome(); stopThinking();
  const { label, a } = toolTitle(name, args);
  const el = document.createElement("div");
  el.className = "tool";
  const isDiff = name === "edit_file" || name === "write_file";
  el.innerHTML =
    `<div class="tool-line"><span class="tool-dot">⏺</span>` +
    `<span class="tool-title"><span class="tname">${label}</span>` +
    `<span class="targs">(${esc(a)})</span></span>` +
    `<span class="spin" style="margin-left:auto">…</span></div>` +
    `<div class="tool-body"><span class="tool-elbow">⎿</span><div class="tool-out"></div></div>`;
  const out = el.querySelector(".tool-out");
  const body = el.querySelector(".tool-body");
  if (name === "edit_file") out.innerHTML = diffHtml(args.old_string, args.new_string);
  else if (name === "write_file") out.innerHTML = `<span class="add">+ created ${esc(args.path || "")}</span>\n` + esc((args.content || "").slice(0, 2000));
  else body.style.display = "none"; // show body once we have output
  scroll.appendChild(el);
  toolEls.set(id, { el, out, body, spin: el.querySelector(".spin"), dot: el.querySelector(".tool-dot"), isDiff });
  scrollDown();
}
function streamTool(id, chunk) {
  const t = toolEls.get(id);
  if (!t || t.isDiff) return;
  t.body.style.display = "flex";
  t.out.textContent += chunk;
  scrollDown();
}
function finishTool(id, result) {
  const t = toolEls.get(id);
  if (!t) return;
  t.spin.remove();
  t.dot.classList.add("done");
  if (!t.isDiff && !t.out.textContent) { t.body.style.display = "flex"; t.out.textContent = result; }
  scrollDown();
}

// thinking with cycling Claude glyph
const GLYPHS = ["✻", "✳", "✶", "✽", "✢", "✦"];
function startThinking() {
  stopThinking();
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML = `<span class="glyph">✻</span> Working…`;
  scroll.appendChild(thinkingEl); scrollDown();
  let i = 0;
  thinkTimer = setInterval(() => {
    const g = thinkingEl && thinkingEl.querySelector(".glyph");
    if (g) g.textContent = GLYPHS[i++ % GLYPHS.length];
  }, 260);
}
function stopThinking() {
  if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

function setBusy(v) {
  busy = v;
  stopBtn.classList.toggle("hidden", !v);
}

// ── agent events ───────────────────────────────────────────────────
api.on("agent:event", (ev) => {
  switch (ev.type) {
    case "thinking": startThinking(); break;
    case "assistant": addAssistant(ev.content); break;
    case "tool_call": addToolCard(ev.id, ev.name, ev.args); break;
    case "tool_stream": streamTool(ev.id, ev.chunk); break;
    case "tool_result": finishTool(ev.id, ev.result); break;
    case "error": addError(ev.message); setBusy(false); break;
    case "aborted": stopThinking(); setBusy(false); break;
    case "done": stopThinking(); setBusy(false); break;
  }
});

api.on("gateway:status", (s) => {
  const dot = $("gw-dot");
  dot.className = "s-dot " + (s.state === "ready" ? "ok" : s.state === "error" ? "err" : "boot");
  $("gw-label").textContent = s.state === "ready" ? "ready" : s.state === "error" ? "engine error" : "starting…";
});
api.on("workspace:changed", (w) => setCwd(w.path));

function setCwd(p) {
  cwd = p;
  $("cwd").textContent = p || "—";
  $("cwd-mini").textContent = p || "";
  fileIndex = null;
}

// ── @-mentions ─────────────────────────────────────────────────────
let chipsEl = null;
function chipsBox() {
  if (!chipsEl) {
    chipsEl = document.createElement("div");
    chipsEl.className = "chips";
    $("inputbox").parentNode.insertBefore(chipsEl, $("inputbox"));
  }
  return chipsEl;
}
function renderChips() {
  const box = chipsBox();
  box.innerHTML = "";
  mentions.forEach((p) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `@${esc(p)} <span class="x">✕</span>`;
    c.querySelector(".x").addEventListener("click", () => { mentions.delete(p); renderChips(); });
    box.appendChild(c);
  });
}
async function buildIndex() {
  if (fileIndex) return fileIndex;
  const out = [];
  async function walk(rel, d) {
    if (d > 4 || out.length > 2000) return;
    const res = await api.listDir(rel);
    if (!res.entries) return;
    for (const e of res.entries) {
      if (e.type === "file") out.push(e.path);
      else await walk(e.path, d + 1);
    }
  }
  await walk(".", 0);
  return (fileIndex = out);
}
let mpop = null, mSel = 0, mMatches = [];
async function showPop(q) {
  const idx = await buildIndex();
  mMatches = idx.filter((p) => p.toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  hidePop();
  if (!mMatches.length) return;
  mSel = 0;
  mpop = document.createElement("div");
  mpop.className = "mpop";
  mMatches.forEach((p, i) => {
    const it = document.createElement("div");
    it.className = "mitem" + (i === 0 ? " sel" : "");
    it.innerHTML = `<span>${esc(p.split("/").pop())}</span><span class="mp">${esc(p)}</span>`;
    it.addEventListener("mousedown", (e) => { e.preventDefault(); pick(p); });
    mpop.appendChild(it);
  });
  document.body.appendChild(mpop);
  const r = $("inputbox").getBoundingClientRect();
  mpop.style.left = r.left + "px";
  mpop.style.bottom = window.innerHeight - r.top + 6 + "px";
  mpop.style.width = Math.min(r.width, 480) + "px";
}
function hidePop() { if (mpop) { mpop.remove(); mpop = null; } mMatches = []; }
function moveSel(d) {
  if (!mpop) return;
  const items = [...mpop.querySelectorAll(".mitem")];
  items[mSel]?.classList.remove("sel");
  mSel = (mSel + d + items.length) % items.length;
  items[mSel]?.classList.add("sel");
  items[mSel]?.scrollIntoView({ block: "nearest" });
}
function pick(p) {
  mentions.add(p); renderChips();
  input.value = input.value.replace(/@[^\s]*$/, "").trimEnd();
  hidePop(); input.focus();
}

// ── composer ───────────────────────────────────────────────────────
function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
input.addEventListener("input", () => {
  grow();
  const m = input.value.match(/@([^\s]*)$/);
  if (m) showPop(m[1]); else hidePop();
});
input.addEventListener("keydown", (e) => {
  if (mpop) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(mMatches[mSel]); return; }
    if (e.key === "Escape") { hidePop(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === "Escape" && busy) api.stop();
});

async function send() {
  const text = input.value.trim();
  if ((!text && !mentions.size) || busy) return;
  let full = text;
  if (mentions.size) full = `${text}\n\nReferenced files: ${[...mentions].map((p) => "@" + p).join(", ")}`;
  addUser(text + (mentions.size ? "  " + [...mentions].map((p) => "@" + p).join(" ") : ""));
  input.value = ""; mentions.clear(); renderChips(); grow(); hidePop();
  setBusy(true);
  await api.sendMessage(full);
}
stopBtn.addEventListener("click", () => api.stop());
document.addEventListener("click", (e) => {
  const t = e.target.closest(".tip");
  if (t) { input.value = t.dataset.prompt; grow(); input.focus(); }
});

// ── wiring ─────────────────────────────────────────────────────────
$("change-cwd").addEventListener("click", () => api.pickWorkspace());
$("new-session").addEventListener("click", async () => { await api.newSession(); location.reload(); });
$("dashboard").addEventListener("click", () => api.openDashboard());
$("model").addEventListener("change", (e) => api.setModel(e.target.value));

(async () => {
  const st = await api.getState();
  if (st) {
    if (st.workspace) setCwd(st.workspace);
    if (st.model) $("model").value = st.model;
  }
  input.focus();
})();
