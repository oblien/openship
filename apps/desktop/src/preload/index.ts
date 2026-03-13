/**
 * Preload script — exposes a safe API to the renderer (onboarding + dashboard).
 *
 * This bridges Electron's main process with the web UI via contextBridge.
 * The renderer never gets direct access to Node.js APIs.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  /** Whether the app is running inside Electron */
  isDesktop: true,

  /** Persistent config store */
  config: {
    get: (key: string) => ipcRenderer.invoke("config:get", key),
    set: (key: string, value: unknown) =>
      ipcRenderer.invoke("config:set", key, value),
    getAll: () => ipcRenderer.invoke("config:getAll"),
  },

  /** App metadata */
  app: {
    version: () => ipcRenderer.invoke("app:version"),
    platform: process.platform,
  },

  /** Navigation */
  navigate: (url: string) => ipcRenderer.invoke("navigate", url),

  /** Onboarding helpers */
  onboarding: {
    /** Test if an API server is reachable */
    testConnection: (apiUrl: string, auth?: Record<string, string>) =>
      ipcRenderer.invoke("onboarding:test-connection", apiUrl, auth),

    /** Mark onboarding as done, save URLs, and load the dashboard */
    complete: (apiUrl: string, dashboardUrl: string) =>
      ipcRenderer.invoke("onboarding:complete", apiUrl, dashboardUrl),

    /** Open a URL in the system browser */
    openExternal: (url: string) =>
      ipcRenderer.invoke("onboarding:open-external", url),

    /** Browse for a file (e.g. SSH key) */
    browseFile: () => ipcRenderer.invoke("onboarding:browse-file"),
  },

  /** Reset config and return to onboarding */
  reset: () => ipcRenderer.invoke("app:reset"),
});
