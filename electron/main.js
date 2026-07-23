"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { Gateway } = require("./sidecar");
const { Agent } = require("./agent");

let win = null;
let gateway = null;
let agent = null;

const state = {
  workspace: process.env.OMNIWORK_WORKSPACE || app?.getPath ? null : null,
  model: "auto",
  gateway: { state: "boot" },
};

function loadPrefs() {
  try {
    const p = path.join(app.getPath("userData"), "prefs.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {};
}
function savePrefs() {
  try {
    const p = path.join(app.getPath("userData"), "prefs.json");
    fs.writeFileSync(p, JSON.stringify({ workspace: state.workspace, model: state.model }, null, 2));
  } catch {}
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: "#09090b",
    title: "OmniWork",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (process.env.OMNIWORK_DEV) win.webContents.openDevTools({ mode: "detach" });
}

// Build/refresh the agent bound to the current workspace + gateway.
function buildAgent() {
  if (!gateway) return;
  agent = new Agent({
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
    model: state.model,
    workspace: state.workspace || os.homedir(),
    emit: (type, payload) => send("agent:event", { type, ...payload }),
  });
}

async function boot() {
  const prefs = loadPrefs();
  state.workspace = prefs.workspace && fs.existsSync(prefs.workspace) ? prefs.workspace : null;
  state.model = prefs.model || "auto";

  createWindow();

  gateway = new Gateway({
    dataDir: app.getPath("userData"),
    onStatus: (s) => {
      state.gateway = s;
      send("gateway:status", s);
    },
  });

  // Start the sidecar; don't block window creation.
  gateway
    .start()
    .then(() => buildAgent())
    .catch((e) => {
      send("gateway:status", { state: "error", detail: e.message });
    });
}

// ---------- IPC ----------
ipcMain.handle("app:state", () => ({
  workspace: state.workspace,
  model: state.model,
  gateway: state.gateway,
}));

ipcMain.handle("app:setModel", (_e, model) => {
  state.model = model;
  if (agent) agent.model = model;
  savePrefs();
  return true;
});

ipcMain.handle("workspace:pick", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
    title: "Choose a workspace folder",
  });
  if (!r.canceled && r.filePaths[0]) {
    state.workspace = r.filePaths[0];
    if (agent) agent.setWorkspace(state.workspace);
    savePrefs();
    send("workspace:changed", { path: state.workspace });
  }
  return state.workspace;
});

ipcMain.handle("agent:send", async (_e, text) => {
  if (!agent) {
    send("agent:event", { type: "error", message: "Engine still starting — try again in a moment." });
    return false;
  }
  if (!state.workspace) {
    // Default to a scratch workspace under the user's home so the app is usable immediately.
    const scratch = path.join(os.homedir(), "OmniWork");
    fs.mkdirSync(scratch, { recursive: true });
    state.workspace = scratch;
    agent.setWorkspace(scratch);
    savePrefs();
    send("workspace:changed", { path: scratch });
  }
  try {
    await agent.send(text);
  } catch (e) {
    send("agent:event", { type: "error", message: e.message });
  }
  return true;
});

ipcMain.handle("agent:stop", () => {
  if (agent) agent.abort();
  return true;
});

ipcMain.handle("agent:new", () => {
  buildAgent();
  return true;
});

ipcMain.handle("gateway:openDashboard", () => {
  if (gateway) shell.openExternal(gateway.dashboardUrl());
  return true;
});

// ---------- file explorer ----------
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".cache",
  ".DS_Store", "coverage", ".turbo", "__pycache__", ".venv", "venv",
]);

function readDir(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env" && e.name !== ".gitignore") {
      if (IGNORE_DIRS.has(e.name)) continue;
    }
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      dirs.push({ name: e.name, type: "dir", path: path.join(dir, e.name) });
    } else if (e.isFile()) {
      files.push({ name: e.name, type: "file", path: path.join(dir, e.name) });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

// List a single directory's children (lazy tree expansion). Paths are relative
// to the workspace root and confined to it.
ipcMain.handle("workspace:list", (_e, relPath) => {
  if (!state.workspace) return { root: null, entries: [] };
  const target = path.resolve(state.workspace, relPath || ".");
  const rel = path.relative(state.workspace, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { root: state.workspace, entries: [] };
  const entries = readDir(target).map((n) => ({
    name: n.name,
    type: n.type,
    path: path.relative(state.workspace, n.path).split(path.sep).join("/"),
  }));
  return { root: state.workspace, base: path.basename(state.workspace), entries };
});

ipcMain.handle("file:read", (_e, relPath) => {
  if (!state.workspace) return { error: "no workspace" };
  const target = path.resolve(state.workspace, relPath);
  const rel = path.relative(state.workspace, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: "path escapes workspace" };
  try {
    const stat = fs.statSync(target);
    if (stat.size > 600 * 1024) return { error: "file too large to preview" };
    return { content: fs.readFileSync(target, "utf8"), path: relPath };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------- lifecycle ----------
app.whenReady().then(boot);

app.on("window-all-closed", () => {
  if (gateway) gateway.stop();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", () => {
  if (gateway) gateway.stop();
});
