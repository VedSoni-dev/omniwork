"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omniwork", {
  platform: process.platform, // renderer needs it for the macOS titlebar inset

  // sessions (Cowork)
  createSession: (opts) => ipcRenderer.invoke("session:create", opts),
  listSessions: () => ipcRenderer.invoke("session:list"),
  setActiveSession: (id) => ipcRenderer.invoke("session:setActive", id),
  getTranscript: (id) => ipcRenderer.invoke("session:transcript", id),
  sendMessage: (id, text, images, label) => ipcRenderer.invoke("session:send", { id, text, images, label }),
  stopSession: (id) => ipcRenderer.invoke("session:stop", id),
  removeSession: (id) => ipcRenderer.invoke("session:remove", id),
  pickWorkspace: (id) => ipcRenderer.invoke("session:pickWorkspace", id),
  setWorkspacePath: (id, p) => ipcRenderer.invoke("session:setWorkspacePath", { id, path: p }),
  revealFolder: (p) => ipcRenderer.invoke("app:revealFolder", p),
  newProject: () => ipcRenderer.invoke("project:new"),
  openMemory: (scope) => ipcRenderer.invoke("memory:open", scope),
  readMemory: (scope, projectId) => ipcRenderer.invoke("memory:read", { scope, projectId }),
  writeMemory: (scope, content, projectId) => ipcRenderer.invoke("memory:write", { scope, content, projectId }),
  projectInfo: (id) => ipcRenderer.invoke("project:info", id),
  updateProject: (id, fields) => ipcRenderer.invoke("project:update", { id, ...fields }),
  writeInstructions: (id, content) => ipcRenderer.invoke("project:instructions", { id, content }),
  addSchedule: (id, prompt, every) => ipcRenderer.invoke("schedule:add", { id, prompt, every }),
  removeSchedule: (id, taskId) => ipcRenderer.invoke("schedule:remove", { id, taskId }),
  openKnowledge: (projectId) => ipcRenderer.invoke("knowledge:open", projectId),
  importKnowledge: (projectId) => ipcRenderer.invoke("knowledge:import", projectId),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  installSkills: (src) => ipcRenderer.invoke("skills:install", src),
  newSkill: (name) => ipcRenderer.invoke("skills:new", name),
  openSkills: () => ipcRenderer.invoke("skills:open"),
  home: process.env.HOME || process.env.USERPROFILE || "",
  undo: (id) => ipcRenderer.invoke("session:undo", id),
  renameSession: (id, title) => ipcRenderer.invoke("session:rename", { id, title }),
  renameProject: (id, name) => ipcRenderer.invoke("project:rename", { id, name }),
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
