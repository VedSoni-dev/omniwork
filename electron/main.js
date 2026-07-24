"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { Gateway } = require("./sidecar");
const { SessionManager } = require("./sessions");
const { MCPManager } = require("./mcp");

let win = null;
let gateway = null;
let sessions = null;
let mcp = null;

const state = { model: "auto", approval: "auto", lastWorkspace: null, gateway: { state: "boot" } };

function prefsPath() { return path.join(app.getPath("userData"), "prefs.json"); }
function loadPrefs() {
  try { if (fs.existsSync(prefsPath())) return JSON.parse(fs.readFileSync(prefsPath(), "utf8")); } catch {}
  return {};
}
function savePrefs() {
  try { fs.writeFileSync(prefsPath(), JSON.stringify({ workspace: state.lastWorkspace, model: state.model, approval: state.approval }, null, 2)); } catch {}
}
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function activeWorkspace() {
  const list = sessions ? sessions.sessions.get(sessions.activeId) : null;
  return (list && list.workspace) || state.lastWorkspace || os.homedir();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1300, height: 880, minWidth: 980, minHeight: 640,
    backgroundColor: "#1c1b19", title: "OmniWork",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (process.env.OMNIWORK_DEV) win.webContents.openDevTools({ mode: "detach" });
}

async function boot() {
  const prefs = loadPrefs();
  const envWs = process.env.OMNIWORK_WORKSPACE;
  if (envWs && fs.existsSync(envWs)) state.lastWorkspace = envWs;
  else if (prefs.workspace && fs.existsSync(prefs.workspace)) state.lastWorkspace = prefs.workspace;
  state.model = prefs.model || "auto";
  state.approval = prefs.approval === "ask" ? "ask" : "auto";

  createWindow();

  gateway = new Gateway({
    dataDir: app.getPath("userData"),
    onStatus: (s) => { state.gateway = s; send("gateway:status", s); },
  });

  gateway.start().then(() => {
    mcp = new MCPManager(app.getPath("userData"));
    sessions = new SessionManager({
      gateway, mcp,
      persistPath: path.join(app.getPath("userData"), "sessions.json"),
      emit: (sessionId, type, payload) => {
        if (sessionId === null) send(type, payload); // broadcasts (e.g. sessions:list)
        else send("session:event", { sessionId, type, ...payload });
      },
    });
    sessions.setModel(state.model);
    sessions.setApprovalMode(state.approval);
    // Restore saved sessions; start a fresh one only if none were persisted.
    const restored = sessions.restore();
    if (!restored) sessions.create({ workspace: state.lastWorkspace, title: "Main" });
    // Bring up MCP servers in the background; refresh connection list when ready.
    mcp.startAll().then(() => send("mcp:list", { servers: mcp.list() })).catch(() => {});
  }).catch((e) => send("gateway:status", { state: "error", detail: e.message }));
}

// ── IPC: app ────────────────────────────────────────────────────────
ipcMain.handle("app:state", () => ({
  model: state.model,
  approval: state.approval,
  gateway: state.gateway,
  sessions: sessions ? sessions.list() : [],
  activeId: sessions ? sessions.activeId : null,
  mcp: mcp ? mcp.list() : [],
}));
ipcMain.handle("app:setModel", (_e, model) => { state.model = model; if (sessions) sessions.setModel(model); savePrefs(); return true; });
ipcMain.handle("gateway:openDashboard", () => { if (gateway) shell.openExternal(gateway.dashboardUrl()); return true; });
ipcMain.handle("models:list", async () => {
  if (!gateway) return [];
  try {
    const res = await fetch(`${gateway.baseUrl}/models`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    return (data.data || []).map((m) => m.id).filter(Boolean);
  } catch { return []; }
});

// ── IPC: sessions (Cowork) ──────────────────────────────────────────
ipcMain.handle("session:create", (_e, opts) => {
  if (!sessions) return null;
  return sessions.create(opts || { workspace: state.lastWorkspace });
});
ipcMain.handle("session:list", () => (sessions ? { sessions: sessions.list(), activeId: sessions.activeId } : { sessions: [], activeId: null }));
ipcMain.handle("session:setActive", (_e, id) => { if (sessions) sessions.setActive(id); return true; });
ipcMain.handle("session:transcript", (_e, id) => (sessions ? sessions.transcript(id) : []));
ipcMain.handle("session:send", async (_e, { id, text, images }) => {
  if (!sessions) { send("session:event", { sessionId: id, type: "error", message: "Engine still starting." }); return false; }
  await sessions.send(id, text, images);
  return true;
});
ipcMain.handle("session:stop", (_e, id) => { if (sessions) sessions.stop(id); return true; });
ipcMain.handle("session:remove", (_e, id) => { if (sessions) sessions.remove(id); return true; });
ipcMain.handle("session:undo", (_e, id) => { if (sessions) sessions.undo(id); return true; });
ipcMain.handle("agent:approve", (_e, { callId, ok }) => { if (sessions) sessions.resolveApproval(callId, ok); return true; });
ipcMain.handle("app:setApproval", (_e, mode) => {
  if (!sessions) return "auto";
  const m = sessions.setApprovalMode(mode);
  state.approval = m; savePrefs();
  return m;
});
ipcMain.handle("session:pickWorkspace", async (_e, id) => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "Choose a folder for this session" });
  if (!r.canceled && r.filePaths[0]) {
    state.lastWorkspace = r.filePaths[0];
    if (sessions) sessions.setWorkspace(id, r.filePaths[0]);
    savePrefs();
    return r.filePaths[0];
  }
  return null;
});

// ── IPC: MCP / connections ──────────────────────────────────────────
ipcMain.handle("mcp:list", () => (mcp ? mcp.list() : []));
ipcMain.handle("mcp:add", async (_e, { name, conf }) => {
  if (!mcp) return [];
  try { await mcp.addServer(name, conf); } catch {}
  const list = mcp.list();
  send("mcp:list", { servers: list });
  return list;
});
ipcMain.handle("mcp:remove", (_e, name) => {
  if (!mcp) return [];
  const list = mcp.removeServer(name);
  send("mcp:list", { servers: list });
  return list;
});

// ── IPC: file explorer (active session's workspace) ─────────────────
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".cache", "coverage", ".turbo", "__pycache__", ".venv", "venv"]);
function readDir(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const dirs = [], files = [];
  for (const e of entries) {
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) dirs.push({ name: e.name, type: "dir" }); }
    else if (e.isFile()) files.push({ name: e.name, type: "file" });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}
ipcMain.handle("workspace:list", (_e, relPath) => {
  const ws = activeWorkspace();
  const target = path.resolve(ws, relPath || ".");
  const rel = path.relative(ws, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { root: ws, entries: [] };
  const entries = readDir(target).map((n) => ({ name: n.name, type: n.type, path: path.relative(ws, path.join(target, n.name)).split(path.sep).join("/") }));
  return { root: ws, base: path.basename(ws), entries };
});
ipcMain.handle("file:read", (_e, relPath) => {
  const ws = activeWorkspace();
  const target = path.resolve(ws, relPath);
  const rel = path.relative(ws, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: "path escapes workspace" };
  try {
    const stat = fs.statSync(target);
    if (stat.size > 600 * 1024) return { error: "file too large to preview" };
    return { content: fs.readFileSync(target, "utf8"), path: relPath };
  } catch (err) { return { error: err.message }; }
});

// ── lifecycle ───────────────────────────────────────────────────────
app.whenReady().then(boot);
app.on("window-all-closed", () => {
  if (mcp) mcp.stopAll();
  if (gateway) gateway.stop();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("before-quit", () => { if (sessions) sessions.save(); if (mcp) mcp.stopAll(); if (gateway) gateway.stop(); });
