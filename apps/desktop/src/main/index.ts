/**
 * Openship Desktop — Electron main process.
 *
 * Flow:
 *   1. App starts → check if onboarding is complete
 *   2. If not → show the local onboarding UI (bundled HTML)
 *   3. User connects to a server → save config → load dashboard
 *   4. If already set up → load dashboard directly
 *
 * Architecture:
 *   Desktop (Electron)
 *     ├─ Onboarding (local HTML, first run only)
 *     └─ Dashboard (Next.js web UI, loaded in BrowserWindow)
 *         └─ API (remote server, reached via HTTP)
 */

import { app, BrowserWindow, shell, ipcMain, net } from "electron";
import { join } from "node:path";
import Store from "electron-store";

// ─── Persistent config ───────────────────────────────────────────────────────

interface AppConfig {
  /** URL of the Openship API server */
  apiUrl: string;
  /** URL of the dashboard */
  dashboardUrl: string;
  /** Whether onboarding has been completed */
  onboardingComplete: boolean;
  /** Window bounds for restore */
  windowBounds?: { x: number; y: number; width: number; height: number };
}

const store = new Store<AppConfig>({
  defaults: {
    apiUrl: "",
    dashboardUrl: "",
    onboardingComplete: false,
  },
});

// ─── Window management ───────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const bounds = store.get("windowBounds");

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1400,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 600,
    title: "Openship",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    show: false, // Show after content is ready
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Show the window once content is painted (avoids white flash)
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Decide what to load
  if (store.get("onboardingComplete")) {
    loadDashboard();
  } else {
    loadOnboarding();
  }

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Save window position on close
  mainWindow.on("close", () => {
    if (mainWindow) {
      store.set("windowBounds", mainWindow.getBounds());
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Loading strategies ──────────────────────────────────────────────────────

function loadOnboarding() {
  if (!mainWindow) return;

  // In dev, electron-vite serves the renderer on a local URL
  // In production, load from the bundled file
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function loadDashboard() {
  if (!mainWindow) return;
  const dashboardUrl = store.get("dashboardUrl");
  if (dashboardUrl) {
    mainWindow.loadURL(dashboardUrl);
  } else {
    // Fallback to onboarding if no dashboard URL set
    loadOnboarding();
  }
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// ─── IPC: Config store ───────────────────────────────────────────────────────

ipcMain.handle("config:get", (_event, key: keyof AppConfig) => {
  return store.get(key);
});

ipcMain.handle("config:set", (_event, key: keyof AppConfig, value: unknown) => {
  store.set(key, value as AppConfig[keyof AppConfig]);
  return true;
});

ipcMain.handle("config:getAll", () => {
  return store.store;
});

// ─── IPC: App metadata ──────────────────────────────────────────────────────

ipcMain.handle("app:version", () => {
  return app.getVersion();
});

// ─── IPC: Navigation ────────────────────────────────────────────────────────

ipcMain.handle("navigate", (_event, url: string) => {
  if (mainWindow) {
    mainWindow.loadURL(url);
  }
});

// ─── IPC: Onboarding ────────────────────────────────────────────────────────

ipcMain.handle("onboarding:test-connection", async (_event, apiUrl: string) => {
  try {
    // Try to reach the API health endpoint
    const response = await net.fetch(`${apiUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });

    if (response.ok) {
      return { ok: true, message: "Connected successfully" };
    }

    return {
      ok: false,
      message: `Server responded with ${response.status}. Make sure Openship API is running.`,
    };
  } catch (err) {
    const message =
      err instanceof Error && err.message.includes("abort")
        ? "Connection timed out — check the URL and make sure the server is running"
        : "Could not reach the server — check the URL and try again";
    return { ok: false, message };
  }
});

ipcMain.handle(
  "onboarding:complete",
  async (_event, apiUrl: string, dashboardUrl: string) => {
    store.set("apiUrl", apiUrl);
    store.set("dashboardUrl", dashboardUrl);
    store.set("onboardingComplete", true);

    // Navigate to dashboard
    loadDashboard();
    return true;
  }
);

ipcMain.handle("onboarding:open-external", (_event, url: string) => {
  shell.openExternal(url);
});

// ─── IPC: Reset (for settings → re-onboard) ─────────────────────────────────

ipcMain.handle("app:reset", () => {
  store.set("onboardingComplete", false);
  store.set("apiUrl", "");
  store.set("dashboardUrl", "");
  loadOnboarding();
  return true;
});
