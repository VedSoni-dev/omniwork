"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omniwork", {
  platform: process.platform, // renderer needs it for the macOS titlebar inset

  // sessions (Cowork)
  createSession: (opts) => ipcRenderer.invoke("session:create", opts),
  listSessions: () => ipcRenderer.invoke("session:list"),
  setActiveSession: (id) => ipcRenderer.invoke("session:setActive", id),
  getTranscript: (id) => ipcRenderer.invoke("session:transcript", id),
  sendMessage: (id, text, images) => ipcRenderer.invoke("session:send", { id, text, images }),
  stopSession: (id) => ipcRenderer.invoke("session:stop", id),
  removeSession: (id) => ipcRenderer.invoke("session:remove", id),
  pickWorkspace: (id) => ipcRenderer.invoke("session:pickWorkspace", id),
  setWorkspacePath: (id, p) => ipcRenderer.invoke("session:setWorkspacePath", { id, path: p }),
  revealFolder: (p) => ipcRenderer.invoke("app:revealFolder", p),
  newProject: () => ipcRenderer.invoke("project:new"),
  openMemory: (scope) => ipcRenderer.invoke("memory:open", scope),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  installSkills: (src) => ipcRenderer.invoke("skills:install", src),
  newSkill: (name) => ipcRenderer.invoke("skills:new", name),
  openSkills: () => ipcRenderer.invoke("skills:open"),
  home: process.env.HOME || process.env.USERPROFILE || "",
  undo: (id) => ipcRenderer.invoke("session:undo", id),
  compactSession: (id) => ipcRenderer.invoke("session:compact", id),
  approve: (callId, ok) => ipcRenderer.invoke("agent:approve", { callId, ok }),
  setApproval: (mode) => ipcRenderer.invoke("app:setApproval", mode),

  // mcp / connections
  listMcp: () => ipcRenderer.invoke("mcp:list"),
  addMcp: (name, conf) => ipcRenderer.invoke("mcp:add", { name, conf }),
  removeMcp: (name) => ipcRenderer.invoke("mcp:remove", name),

  // files (active session workspace)
  listDir: (relPath) => ipcRenderer.invoke("workspace:list", relPath),
  readFile: (relPath) => ipcRenderer.invoke("file:read", relPath),

  // app
  getState: () => ipcRenderer.invoke("app:state"),
  listModels: () => ipcRenderer.invoke("models:list"),
  setModel: (model) => ipcRenderer.invoke("app:setModel", model),
  openDashboard: () => ipcRenderer.invoke("gateway:openDashboard"),

  on: (channel, cb) => {
    const allowed = new Set(["session:event", "sessions:list", "gateway:status", "mcp:list", "skills:list"]);
    if (!allowed.has(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
