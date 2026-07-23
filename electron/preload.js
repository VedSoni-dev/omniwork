"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Safe, minimal bridge between the renderer UI and the main process.
contextBridge.exposeInMainWorld("omniwork", {
  // Fire-and-forget / request-response
  sendMessage: (text) => ipcRenderer.invoke("agent:send", text),
  stop: () => ipcRenderer.invoke("agent:stop"),
  newSession: () => ipcRenderer.invoke("agent:new"),
  pickWorkspace: () => ipcRenderer.invoke("workspace:pick"),
  getState: () => ipcRenderer.invoke("app:state"),
  setModel: (model) => ipcRenderer.invoke("app:setModel", model),
  openDashboard: () => ipcRenderer.invoke("gateway:openDashboard"),

  // Streaming events from the agent + gateway
  on: (channel, cb) => {
    const allowed = new Set([
      "agent:event",
      "gateway:status",
      "workspace:changed",
    ]);
    if (!allowed.has(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
