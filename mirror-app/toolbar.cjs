// Preload of the toolbar: the few calls toolbar.html makes to the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mirror", {
  send: (cmd, arg) => ipcRenderer.send("mirror:ctl", cmd, arg),
  onState: (cb) => ipcRenderer.on("mirror:state", (_e, s) => cb(s)),
});
