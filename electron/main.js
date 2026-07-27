"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { ensureShellPath } = require("./shell-path");
const { Gateway } = require("./sidecar");
const { SessionManager } = require("./sessions");
const { MCPManager } = require("./mcp");
const { ProjectManager } = require("./projects");
const { BrowserManager } = require("./browser");

// Do this before anything spawns a child: a Finder/Dock launch hands us a bare
// PATH, which would break `npx` MCP servers and the agent's run_command.
ensureShellPath();

let win = null;
let gateway = null;
let sessions = null;
let mcp = null;
let projects = null;
let browser = null;

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
  if (process.env.OMNIWORK_DEV) {
    win.webContents.openDevTools({ mode: "detach" });
    // Surface renderer errors in the terminal — silent UI failures are unfindable otherwise.
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) console.log("[renderer]", msg); });
  }
  // Scripted UI test: evaluate a JS file in the page and print its result.
  if (process.env.OMNIWORK_UI_TEST) {
    setTimeout(() => {
      win.webContents.executeJavaScript(fs.readFileSync(process.env.OMNIWORK_UI_TEST, "utf8"), true)
        .then((r) => console.log("[ui-test]", JSON.stringify(r)))
        .catch((e) => console.log("[ui-test-error]", e.message));
    }, 15_000);
  }
}

async function boot() {
  const prefs = loadPrefs();
  const envWs = process.env.OMNIWORK_WORKSPACE;
  if (envWs && fs.existsSync(envWs)) state.lastWorkspace = envWs;
  else if (prefs.workspace && fs.existsSync(prefs.workspace)) state.lastWorkspace = prefs.workspace;
  state.model = prefs.model || "auto";
  state.approval = ["auto", "ask", "edits", "plan"].includes(prefs.approval) ? prefs.approval : "auto";

  createWindow();

  gateway = new Gateway({
    dataDir: app.getPath("userData"),
    onStatus: (s) => { state.gateway = s; send("gateway:status", s); },
  });

  gateway.start().then(() => {
    mcp = new MCPManager(app.getPath("userData"));
    projects = new ProjectManager(path.join(app.getPath("userData"), "projects"));
    browser = new BrowserManager();
    sessions = new SessionManager({
      gateway, mcp, projects, browser,
      globalMemoryDir: path.join(app.getPath("userData"), "memory"),
      skillsDir: path.join(app.getPath("userData"), "skills"),
      legacyPath: path.join(app.getPath("userData"), "sessions.json"),
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
    installDefaultSkills();
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
  return sessions.create({ workspace: state.lastWorkspace || undefined, ...(opts || {}) });
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
ipcMain.handle("session:rename", (_e, { id, title }) => { if (sessions) sessions.rename(id, title); return true; });
ipcMain.handle("project:rename", (_e, { id, name }) => { if (sessions) sessions.renameProject(id, name); return true; });
ipcMain.handle("session:compact", async (_e, id) => { if (sessions) await sessions.compactNow(id); return true; });
ipcMain.handle("agent:approve", (_e, { callId, ok }) => { if (sessions) sessions.resolveApproval(callId, ok); return true; });
ipcMain.handle("app:setApproval", (_e, mode) => {
  if (!sessions) return "auto";
  const m = sessions.setApprovalMode(mode);
  state.approval = m; savePrefs();
  return m;
});
ipcMain.handle("app:revealFolder", (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); return true; });

// New project = pick a folder, start its first session there.
ipcMain.handle("project:new", async () => {
  if (!sessions) return { error: "starting" };
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "Choose a project folder" });
  if (r.canceled || !r.filePaths[0]) return null;
  state.lastWorkspace = r.filePaths[0];
  savePrefs();
  return sessions.create({ workspace: r.filePaths[0] });
});

// Every install starts with Anthropic's public skill set. Background,
// marker-gated (won't clobber user edits on later boots), and silent on
// failure — needs git + network, and the app is fully usable without it.
function installDefaultSkills() {
  const marker = path.join(skillsDir(), ".defaults-installed");
  if (fs.existsSync(marker)) return;
  skillsApi.installSkills(skillsDir(), "anthropics/skills").then((names) => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ when: new Date().toISOString(), source: "anthropics/skills", names }, null, 2));
    broadcastSkills();
  }).catch(() => {});
}

// ── IPC: skills ─────────────────────────────────────────────────────
const skillsApi = require("./skills");
const skillsDir = () => path.join(app.getPath("userData"), "skills");
const broadcastSkills = () => send("skills:list", { skills: skillsApi.listSkills(skillsDir(), activeWorkspace()) });
ipcMain.handle("skills:list", () => skillsApi.listSkills(skillsDir(), activeWorkspace()));
ipcMain.handle("skills:install", async (_e, source) => {
  try {
    const installed = await skillsApi.installSkills(skillsDir(), source);
    broadcastSkills();
    return { installed };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle("skills:new", (_e, name) => {
  try {
    const made = skillsApi.createSkill(skillsDir(), name || "my-skill", "Describe when to use this skill.", null);
    shell.showItemInFolder(made.file);
    broadcastSkills();
    return { name: made.name };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle("skills:open", () => { fs.mkdirSync(skillsDir(), { recursive: true }); shell.openPath(skillsDir()); return true; });

// Open a project's memory file (or the global one) in the OS file manager/editor.
ipcMain.handle("memory:open", (_e, scope) => {
  if (!projects) return false;
  const { memoryFile } = require("./memory");
  const s = sessions && sessions.sessions.get(sessions.activeId);
  const dir = scope === "global" || !s
    ? path.join(app.getPath("userData"), "memory")
    : projects.memoryDir(s.projectId);
  fs.mkdirSync(dir, { recursive: true });
  const f = memoryFile(dir);
  if (!fs.existsSync(f)) fs.writeFileSync(f, "# Memory\n\nNothing saved yet — the agent adds entries here with save_memory.\n");
  shell.showItemInFolder(f);
  return true;
});
ipcMain.handle("session:setWorkspacePath", (_e, { id, path: p }) => {
  if (!sessions || !p || !fs.existsSync(p)) return null;
  state.lastWorkspace = p;
  sessions.setWorkspace(id, p);
  savePrefs();
  return p;
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

// On macOS the app stays alive after the last window closes, so the gateway and
// MCP servers must stay up too — otherwise reopening from the dock lands on a
// dead engine. Everywhere else, closing the window really is quitting.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (mcp) mcp.stopAll();
    if (gateway) gateway.stop();
    app.quit();
  }
});

app.on("activate", () => {
  const open = BrowserWindow.getAllWindows();
  if (open.length === 0) createWindow();
  else { win = open[0]; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (sessions) sessions.save({ immediate: true }); // debounced save would never fire
  if (browser) browser.dispose();
  if (mcp) mcp.stopAll();
  if (gateway) gateway.stop();
}

app.on("before-quit", shutdown);

// `before-quit` does not fire when the process is signalled (terminal Ctrl-C,
// a `kill`, logout). Without this the gateway is orphaned and keeps holding
// port 20128, so the next launch adopts a sidecar nobody owns.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { shutdown(); app.quit(); process.exit(0); });
}
