/**
 * Preload script - exposes a safe API to the renderer (onboarding + dashboard).
 *
 * This bridges Electron's main process with the web UI via contextBridge.
 * The renderer never gets direct access to Node.js APIs.
 */

import { contextBridge, ipcRenderer } from "electron";
// Type-only: erased at compile time, so this never becomes a runtime require.
import type { RendererConfigKey } from "../main/security";
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

  /**
   * Persistent config store — update preferences only (see RENDERER_CONFIG_KEYS
   * in main/security.ts, which enforces the key allowlist). No `getAll`: the same
   * store holds SSH credentials and tunnel tokens.
   */
  config: {
    get: (key: RendererConfigKey) => ipcRenderer.invoke("config:get", key),
    set: (key: RendererConfigKey, value: unknown) =>
      ipcRenderer.invoke("config:set", key, value),
  },

  /** App metadata */
  app: {
    version: () => ipcRenderer.invoke("app:version"),
    platform: process.platform,
    localUrls: () => ipcRenderer.invoke("app:local-urls"),
  },

  /** Local control-plane host (fingerprint, ports, engine actions). */
  instance: {
    info: () => ipcRenderer.invoke("instance:info"),
    openBrowser: () => ipcRenderer.invoke("instance:open-browser"),
    openDataFolder: () => ipcRenderer.invoke("instance:open-data"),
    restartEngine: () => ipcRenderer.invoke("instance:restart"),
    repairEndpoint: () => ipcRenderer.invoke("instance:repair"),
    backup: () => ipcRenderer.invoke("instance:backup"),
    onChange: (cb: (info: unknown) => void) => {
      const h = (_e: unknown, info: unknown) => cb(info);
      ipcRenderer.on("instance:changed", h);
      return () => ipcRenderer.removeListener("instance:changed", h);
    },
  },

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

    /** Browse for a file (e.g. SSH key) */
    browseFile: () => ipcRenderer.invoke("onboarding:browse-file"),
  },

  /**
   * System utilities. SSH credentials are deliberately absent — there is no read
   * or write channel for them (see the note in main/index.ts); the dashboard goes
   * through the API under a real session.
   */
  system: {
    /** Native folder picker - returns absolute path or null */
    browseFolder: () => ipcRenderer.invoke("system:browse-folder"),
    /** Native file picker for an SSH key - returns absolute path or null */
    browseFile: () => ipcRenderer.invoke("system:browse-file"),
  },

  /** Named desktop views. Identity and infrastructure stay local and shared. */
  profiles: {
    list: () => ipcRenderer.invoke("profiles:list"),
    create: (name: string) => ipcRenderer.invoke("profiles:create", name),
    rename: (id: string, name: string) => ipcRenderer.invoke("profiles:rename", id, name),
    switch: (id: string) => ipcRenderer.invoke("profiles:switch", id),
    remove: (id: string) => ipcRenderer.invoke("profiles:remove", id),
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
