const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mailboxes", {
  list: () => ipcRenderer.invoke("mail:list"),
  connect: (connection) => ipcRenderer.invoke("mail:connect", connection),
  open: (id) => ipcRenderer.invoke("mail:open", id),
  forget: (id) => ipcRenderer.invoke("mail:forget", id),
});

contextBridge.exposeInMainWorld("mailFrame", {
  mac: process.platform === "darwin",
  action: (action) => ipcRenderer.send("mail:window-action", action),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("mail:window-state", listener);
    ipcRenderer.send("mail:window-action", "state");
    return () => ipcRenderer.removeListener("mail:window-state", listener);
  },
});
