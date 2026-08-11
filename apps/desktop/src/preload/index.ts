/**
 * Preload script - exposes a safe API to the renderer (onboarding + dashboard).
 *
 * This bridges Electron's main process with the web UI via contextBridge.
 * The renderer never gets direct access to Node.js APIs.
 */

import { contextBridge, ipcRenderer } from "electron";
let onboardingUtils: {
  isPrivateIp?: typeof import("@repo/onboarding").isPrivateIp;
  validateServerAddress?: typeof import("@repo/onboarding").validateServerAddress;
  validateSshPayload?: typeof import("@repo/onboarding").validateSshPayload;
  buildSshSettings?: typeof import("@repo/onboarding").buildSshSettings;
} = {};
try {
  onboardingUtils = require("@repo/onboarding");
} catch {
  // Non-critical: utils won't be available but IPC bridge still works
}

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

    /** Poll for cloud auth completion - returns { status: "pending" | "resolved" | "expired" } */
    cloudAuthPoll: (nonce: string) =>
      ipcRenderer.invoke("onboarding:cloud-auth-poll", nonce),

    /** Browse for a file (e.g. SSH key) */
    browseFile: () => ipcRenderer.invoke("onboarding:browse-file"),
  },

  /** System utilities */
  system: {
    /** Native folder picker - returns absolute path or null */
    browseFolder: () => ipcRenderer.invoke("system:browse-folder"),

    /** Get local system settings (SSH creds, etc.) */
    getSettings: () => ipcRenderer.invoke("system:get-settings"),

    /** Update local system settings (partial merge) */
    updateSettings: (settings: Record<string, unknown>) =>
      ipcRenderer.invoke("system:update-settings", settings),
  },

  /** Cloud connection from settings (reconnect without onboarding side-effects) */
  cloud: {
    /** Start cloud connect flow - opens system browser with PKCE */
    connect: () => ipcRenderer.invoke("cloud:connect"),
    /** Poll for connect completion */
    connectPoll: (nonce: string) => ipcRenderer.invoke("cloud:connect-poll", nonce),
  },

  /** Reset config and return to onboarding */
  reset: () => ipcRenderer.invoke("app:reset"),

  /** In-app updater (drives the update window). */
  updates: {
    /** Re-check GitHub on demand and stage the result. Returns the check result
     *  ({ available, version, ... } | { available: false }). */
    check: () => ipcRenderer.invoke("update:check"),
    /** Begin download + install of the pending update (re-checks if none staged). */
    start: () => ipcRenderer.invoke("update:start"),
    /** Open the native update window (re-checks + stages if none pending). */
    open: () => ipcRenderer.invoke("update:open"),
    /** Dismiss / close the update window ("Later"). */
    dismiss: () => ipcRenderer.invoke("update:dismiss"),
    /** Subscribe to download progress (0..1). Returns an unsubscribe fn. */
    onProgress: (cb: (fraction: number) => void) => {
      const h = (_e: unknown, f: number) => cb(f);
      ipcRenderer.on("update:progress", h);
      return () => ipcRenderer.removeListener("update:progress", h);
    },
    /** Fired once the download finishes and install begins. */
    onDone: (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on("update:done", h);
      return () => ipcRenderer.removeListener("update:done", h);
    },
    /** Fired if the update fails; receives an error message. */
    onError: (cb: (message: string) => void) => {
      const h = (_e: unknown, msg: string) => cb(msg);
      ipcRenderer.on("update:error", h);
      return () => ipcRenderer.removeListener("update:error", h);
    },
  },

  /**
   * Window controls for the app's own header bar (see DesktopChrome in the
   * dashboard). macOS keeps its native traffic lights, so only Windows/Linux
   * actually render buttons — but the whole surface is exposed on every platform
   * so the renderer never has to branch on process.platform.
   */
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    /** Maximize, or restore if already maximized. */
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),

    /** Titlebar navigation. canGoBack/canGoForward can only be answered by the
     *  main process — see the note on the IPC handlers. */
    back: () => ipcRenderer.invoke("window:nav-back"),
    forward: () => ipcRenderer.invoke("window:nav-forward"),
    reload: () => ipcRenderer.invoke("window:reload"),
    navState: (): Promise<{ canGoBack: boolean; canGoForward: boolean }> =>
      ipcRenderer.invoke("window:nav-state"),
    /** Only route to DevTools on Windows/Linux — those are frameless and have no
     *  menu bar. macOS also has Electron's default View menu. */
    toggleDevTools: () => ipcRenderer.invoke("window:toggle-devtools"),
    onNavStateChange: (cb: (s: { canGoBack: boolean; canGoForward: boolean }) => void) => {
      const h = (_e: unknown, s: { canGoBack: boolean; canGoForward: boolean }) => cb(s);
      ipcRenderer.on("window:nav-state-change", h);
      return () => ipcRenderer.removeListener("window:nav-state-change", h);
    },
    /** Track real maximize state so the restore icon can't drift out of sync
     *  (the window can also be maximized by the OS, a double-click, or a
     *  keyboard shortcut — none of which go through toggleMaximize). */
    onMaximizedChange: (cb: (maximized: boolean) => void) => {
      const h = (_e: unknown, maximized: boolean) => cb(maximized);
      ipcRenderer.on("window:maximized-change", h);
      return () => ipcRenderer.removeListener("window:maximized-change", h);
    },
  },

  /** Shared onboarding utilities from @repo/onboarding */
  utils: {
    isPrivateIp: onboardingUtils.isPrivateIp ?? (() => false),
    validateServerAddress: onboardingUtils.validateServerAddress ?? (() => ({ valid: false, error: "unavailable" })),
    validateSshPayload: onboardingUtils.validateSshPayload ?? (() => ({ valid: false })),
    buildSshSettings: onboardingUtils.buildSshSettings ?? (() => ({})),
  },
});
