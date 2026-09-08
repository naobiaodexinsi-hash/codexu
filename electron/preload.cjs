const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexU", {
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  refreshDashboard: () => ipcRenderer.invoke("dashboard:refresh"),
  notifyRendered: () => ipcRenderer.send("dashboard:rendered"),
  windowControl: (action) => ipcRenderer.invoke("window:control", action)
});
