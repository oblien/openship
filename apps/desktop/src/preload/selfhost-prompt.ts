/**
 * Preload for the small "connect to self-hosted" prompt only.
 *
 * This file is never attached to the remote dashboard window. The remote
 * window has no preload: Electron would re-attach `window.desktop` to that
 * origin if it did.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("selfhostPrompt", {
  connect: (url: string) => ipcRenderer.invoke("selfhost:connect", url),
  cancel: () => ipcRenderer.invoke("selfhost:cancel-prompt"),
});
