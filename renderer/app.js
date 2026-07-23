"use strict";
const api = window.omniwork;

const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const statusHint = $("status-hint");

let busy = false;
let thinkingEl = null;
const toolEls = new Map(); // tool_call id -> { card, output }

// ---------- rendering helpers ----------
function clearWelcome() {
  const w = $("welcome");
  if (w) w.remove();
}

function scrollDown() {
  transcript.scrollTop = transcript.scrollHeight;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Minimal markdown: fenced code blocks + inline code. Everything else escaped.
function renderMarkdown(text) {
  const parts = text.split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const body = parts[i].replace(/^[a-zA-Z0-9]*\n/, "");
      html += `<pre><code>${escapeHtml(body)}</code></pre>`;
    } else {
      let seg = escapeHtml(parts[i]).replace(/`([^`]+)`/g, "<code>$1</code>");
      html += seg;
    }
  }
  return html;
}

function addMessage(role, content) {
  clearWelcome();
  removeThinking();
  const row = document.createElement("div");
  row.className = "msg-row";
  const isUser = role === "user";
  row.innerHTML = `
    <div class="msg">
      <div class="avatar ${isUser ? "user" : "assistant"}">${isUser ? "You"[0] : "◇"}</div>
      <div class="msg-body">
        <div class="msg-role">${isUser ? "You" : "OmniWork"}</div>
        <div class="msg-content">${renderMarkdown(content)}</div>
      </div>
    </div>`;
  transcript.appendChild(row);
  scrollDown();
}

function toolArgPreview(name, args) {
  if (name === "run_command") return args.command || "";
  if (args.path) return args.path;
  return Object.values(args)[0] ? String(Object.values(args)[0]).slice(0, 60) : "";
}

function toolIcon(name) {
  return (
    {
      run_command: "⌘",
      read_file: "📄",
      write_file: "✍",
      edit_file: "✎",
      list_dir: "📁",
    }[name] || "•"
  );
}

function addToolCard(id, name, args) {
  clearWelcome();
  removeThinking();
  const card = document.createElement("div");
  card.className = "tool-card";
  card.innerHTML = `
    <div class="tool-inner">
      <div class="tool-head">
        <span class="tool-chevron">›</span>
        <span class="tool-icon">${toolIcon(name)}</span>
        <span class="tool-name">${name}</span>
        <span class="tool-arg">${escapeHtml(toolArgPreview(name, args))}</span>
        <span class="tool-spin">running…</span>
      </div>
      <div class="tool-output"></div>
    </div>`;
  const head = card.querySelector(".tool-head");
  head.addEventListener("click", () => card.classList.toggle("open"));
  transcript.appendChild(card);
  toolEls.set(id, {
    card,
    output: card.querySelector(".tool-output"),
    spin: card.querySelector(".tool-spin"),
  });
  scrollDown();
}

function streamTool(id, chunk) {
  const el = toolEls.get(id);
  if (!el) return;
  el.output.textContent += chunk;
}

function finishToolCard(id, result) {
  const el = toolEls.get(id);
  if (!el) return;
  el.spin.textContent = "";
  if (!el.output.textContent) el.output.textContent = result;
  scrollDown();
}

function showThinking() {
  removeThinking();
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML = `Working <span class="dots"><span>.</span><span>.</span><span>.</span></span>`;
  transcript.appendChild(thinkingEl);
  scrollDown();
}
function removeThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

function showError(message) {
  removeThinking();
  const el = document.createElement("div");
  el.className = "error-banner";
  el.innerHTML = `<div class="error-inner">⚠ ${escapeHtml(message)}</div>`;
  transcript.appendChild(el);
  scrollDown();
}

// ---------- state / busy ----------
function setBusy(v) {
  busy = v;
  sendBtn.classList.toggle("hidden", v);
  stopBtn.classList.toggle("hidden", !v);
  statusHint.textContent = v ? "Working…" : "Ready";
}

// ---------- agent events ----------
api.on("agent:event", (ev) => {
  switch (ev.type) {
    case "thinking": showThinking(); break;
    case "assistant": addMessage("assistant", ev.content); break;
    case "tool_call": addToolCard(ev.id, ev.name, ev.args); break;
    case "tool_stream": streamTool(ev.id, ev.chunk); break;
    case "tool_result": finishToolCard(ev.id, ev.result); break;
    case "error": showError(ev.message); setBusy(false); break;
    case "aborted": removeThinking(); setBusy(false); break;
    case "done": removeThinking(); setBusy(false); break;
  }
});

// ---------- gateway status ----------
api.on("gateway:status", (s) => {
  const dot = $("gateway-dot");
  const label = $("gateway-label");
  const sub = $("gateway-sub");
  dot.className = "dot " + (s.state === "ready" ? "dot-ok" : s.state === "error" ? "dot-err" : "dot-boot");
  label.textContent =
    s.state === "ready" ? "Engine ready" : s.state === "error" ? "Engine error" : "Starting engine…";
  if (s.detail) sub.textContent = s.detail;
});

api.on("workspace:changed", (w) => {
  $("workspace-path").textContent = w.path || "No folder open";
});

// ---------- composer ----------
function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
input.addEventListener("input", autoGrow);

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  addMessage("user", text);
  input.value = "";
  autoGrow();
  setBusy(true);
  await api.sendMessage(text);
}

sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => api.stop());
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) {
    input.value = chip.dataset.prompt;
    autoGrow();
    input.focus();
  }
});

$("new-session").addEventListener("click", async () => {
  await api.newSession();
  transcript.innerHTML = "";
  location.reload();
});
$("pick-workspace").addEventListener("click", () => api.pickWorkspace());
$("open-dashboard").addEventListener("click", () => api.openDashboard());
$("model-select").addEventListener("change", (e) => api.setModel(e.target.value));

// ---------- init ----------
(async () => {
  const state = await api.getState();
  if (state) {
    if (state.workspace) $("workspace-path").textContent = state.workspace;
    if (state.model) $("model-select").value = state.model;
    if (state.gateway) {
      api.on; // no-op; status pushed separately
    }
  }
})();
