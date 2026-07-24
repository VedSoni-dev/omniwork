"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omniwork", {
  // sessions (Cowork)
  createSession: (opts) => ipcRenderer.invoke("session:create", opts),
  listSessions: () => ipcRenderer.invoke("session:list"),
  setActiveSession: (id) => ipcRenderer.invoke("session:setActive", id),
  getTranscript: (id) => ipcRenderer.invoke("session:transcript", id),
  sendMessage: (id, text) => ipcRenderer.invoke("session:send", { id, text }),
  stopSession: (id) => ipcRenderer.invoke("session:stop", id),
  removeSession: (id) => ipcRenderer.invoke("session:remove", id),
  pickWorkspace: (id) => ipcRenderer.invoke("session:pickWorkspace", id),
  undo: (id) => ipcRenderer.invoke("session:undo", id),
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
  setModel: (model) => ipcRenderer.invoke("app:setModel", model),
  openDashboard: () => ipcRenderer.invoke("gateway:openDashboard"),

  on: (channel, cb) => {
    const allowed = new Set(["session:event", "sessions:list", "gateway:status", "mcp:list"]);
    if (!allowed.has(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
