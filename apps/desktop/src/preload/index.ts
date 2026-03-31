/**
 * Preload script — exposes a safe API to the renderer (onboarding + dashboard).
 *
 * This bridges Electron's main process with the web UI via contextBridge.
 * The renderer never gets direct access to Node.js APIs.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  isPrivateIp,
  validateServerAddress,
  validateSshPayload,
  buildSshSettings,
} from "@repo/onboarding";

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
    cloudUrls: () => ipcRenderer.invoke("app:cloud-urls"),
    localUrls: () => ipcRenderer.invoke("app:local-urls"),
  },

  /** Navigation */
  navigate: (url: string) => ipcRenderer.invoke("navigate", url),

  /** Onboarding helpers */
  onboarding: {
    /** Mark onboarding as done, push settings to API, and load the dashboard */
    complete: (
      apiUrl: string,
      dashboardUrl: string,
      sshPayload?: Record<string, unknown> | null,
      buildMode?: string,
    ) =>
      ipcRenderer.invoke(
        "onboarding:complete",
        apiUrl,
        dashboardUrl,
        sshPayload,
        buildMode,
      ),

    /** Open a URL in the system browser */
    openExternal: (url: string) =>
      ipcRenderer.invoke("onboarding:open-external", url),

    /** Start cloud authentication flow (opens system browser) */
    cloudAuth: () => ipcRenderer.invoke("onboarding:cloud-auth"),

    /** Poll for cloud auth completion — returns { status: "pending" | "resolved" | "expired" } */
    cloudAuthPoll: (nonce: string) =>
      ipcRenderer.invoke("onboarding:cloud-auth-poll", nonce),

    /** Browse for a file (e.g. SSH key) */
    browseFile: () => ipcRenderer.invoke("onboarding:browse-file"),
  },

  /** System utilities */
  system: {
    /** Native folder picker — returns absolute path or null */
    browseFolder: () => ipcRenderer.invoke("system:browse-folder"),

    /** Get local system settings (SSH creds, etc.) */
    getSettings: () => ipcRenderer.invoke("system:get-settings"),

    /** Update local system settings (partial merge) */
    updateSettings: (settings: Record<string, unknown>) =>
      ipcRenderer.invoke("system:update-settings", settings),
  },

  /** Cloud connection from settings (reconnect without onboarding side-effects) */
  cloud: {
    /** Start cloud connect flow — opens system browser with PKCE */
    connect: () => ipcRenderer.invoke("cloud:connect"),
    /** Poll for connect completion */
    connectPoll: (nonce: string) => ipcRenderer.invoke("cloud:connect-poll", nonce),
  },

  /** Reset config and return to onboarding */
  reset: () => ipcRenderer.invoke("app:reset"),

  /** Shared onboarding utilities from @repo/onboarding */
  utils: {
    isPrivateIp,
    validateServerAddress,
    validateSshPayload,
    buildSshSettings,
  },
});
