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

import { app, BrowserWindow, shell, ipcMain, net, dialog, globalShortcut } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { hostname } from "node:os";

// ─── Persistent config ───────────────────────────────────────────────────────

/**
 * System settings — stored locally in the Electron config file.
 * SSH credentials and server connection details never leave the machine.
 * Platform preferences (build mode) are stored on the API server.
 */
interface SystemSettings {
  /** Friendly name shown in the UI for this server */
  serverName?: string;
  /** SSH host for self-hosted deployments */
  sshHost?: string;
  /** SSH port (default 22) */
  sshPort?: number;
  /** SSH username (default "root") */
  sshUser?: string;
  /** Auth method: "password" | "key" */
  sshAuthMethod?: string;
  /** SSH password (encrypted at rest by OS keychain or plain in config) */
  sshPassword?: string;
  /** Path to SSH private key */
  sshKeyPath?: string;
  /** SSH key passphrase */
  sshKeyPassphrase?: string;
  /** Jump/bastion host */
  sshJumpHost?: string;
  /** Extra SSH arguments */
  sshArgs?: string;
}

interface TunnelConfig {
  /** Tunnel provider: "edge" | "cloudflare" | "ngrok" */
  provider: string;
  /** Auth token for Cloudflare/ngrok (not needed for Edge) */
  token?: string;
}

interface AppConfig {
  /** URL of the Openship API server */
  apiUrl: string;
  /** URL of the dashboard */
  dashboardUrl: string;
  /** Whether onboarding has been completed */
  onboardingComplete: boolean;
  /** Window bounds for restore */
  windowBounds?: { x: number; y: number; width: number; height: number };
  /** System-level settings — SSH creds, kept locally as backup */
  system?: SystemSettings;
  /** Tunnel configuration — pushed to API during onboarding */
  tunnel?: TunnelConfig;
}

const defaults: AppConfig = {
  apiUrl: "",
  dashboardUrl: "",
  onboardingComplete: false,
};

/** Minimal JSON config store using app.getPath('userData') */
class ConfigStore {
  private data: AppConfig;
  private filePath: string;

  constructor() {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, "config.json");

    try {
      this.data = { ...defaults, ...JSON.parse(readFileSync(this.filePath, "utf-8")) };
    } catch {
      this.data = { ...defaults };
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.data[key];
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    this.data[key] = value;
    this.save();
  }

  getAll(): AppConfig {
    return { ...this.data };
  }

  clear() {
    this.data = { ...defaults };
    this.save();
  }

  private save() {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

const store = new ConfigStore();

// ─── Internal token (ephemeral, per-session) ─────────────────────────────────

/**
 * Shared secret for Electron → API internal calls.
 *
 * Security model:
 *   1. Generated fresh each app launch (never persisted to disk)
 *   2. Passed to the API process via INTERNAL_TOKEN env var at spawn time
 *   3. Only Electron (parent) and API (child) share it in memory
 *   4. API only listens on 127.0.0.1 in desktop mode (network-level protection)
 *   5. Other local apps can't read another process's env vars (OS-level isolation)
 *
 * This is the same pattern used by VS Code (language server tokens),
 * Docker Desktop (socket auth), and Jupyter (notebook tokens).
 */
const internalToken = randomBytes(32).toString("base64url");

/**
 * Push instance settings (SSH, tunnel, build mode) directly to the API.
 * Authenticated with the internal token — no user session needed.
 */
async function pushInstanceSettings(
  apiUrl: string,
  settings: {
    system?: SystemSettings;
    tunnel?: TunnelConfig;
    buildMode?: string;
    authMode?: string;
  },
) {
  const payload: Record<string, unknown> = {
    defaultBuildMode: settings.buildMode || "auto",
    authMode: settings.authMode || "none",
  };

  // SSH creds
  if (settings.system) {
    const s = settings.system;
    payload.serverName = s.serverName || null;
    payload.sshHost = s.sshHost;
    payload.sshPort = s.sshPort || 22;
    payload.sshUser = s.sshUser || "root";
    payload.sshAuthMethod = s.sshAuthMethod;
    if (s.sshPassword) payload.sshPassword = s.sshPassword;
    if (s.sshKeyPath) payload.sshKeyPath = s.sshKeyPath;
    if (s.sshKeyPassphrase) payload.sshKeyPassphrase = s.sshKeyPassphrase;
    if (s.sshJumpHost) payload.sshJumpHost = s.sshJumpHost;
    if (s.sshArgs) payload.sshArgs = s.sshArgs;
  }

  // Tunnel
  if (settings.tunnel) {
    payload.tunnelProvider = settings.tunnel.provider;
    if (settings.tunnel.token) payload.tunnelToken = settings.tunnel.token;
  }

  try {
    await net.fetch(`${apiUrl}/api/system/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": internalToken,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // Log but don't block — settings can be pushed again later
    console.error("[openship] Failed to push instance settings:", err);
  }
}

// ─── Cloud defaults (overridable via env for development) ─────────────────────

const CLOUD_API_URL = process.env.OPENSHIP_CLOUD_URL || "https://api.openship.io";
const CLOUD_DASHBOARD_URL = process.env.OPENSHIP_CLOUD_DASHBOARD_URL || "https://app.openship.io";

// Local services for desktop cloud mode (API returns authMode:"cloud", dashboard redirects externally)
const LOCAL_API_URL = process.env.LOCAL_API_URL || "http://localhost:4000";
const LOCAL_DASHBOARD_URL = process.env.LOCAL_DASHBOARD_URL || "http://localhost:3001";

// ─── API readiness check ──────────────────────────────────────────────────────

/**
 * Poll the local API health endpoint until it responds OK.
 * Returns true when API is ready, false if it never becomes ready.
 */
async function waitForApi(apiUrl: string, maxAttempts = 30, intervalMs = 1000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await net.fetch(`${apiUrl}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // Not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

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

  mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

function loadDashboard() {
  if (!mainWindow) return;
  const dashboardUrl = store.get("dashboardUrl");
  if (!dashboardUrl) {
    loadOnboarding();
    return;
  }

  mainWindow.loadURL(dashboardUrl).catch(() => {
    store.set("onboardingComplete", false);
    store.set("apiUrl", "");
    store.set("dashboardUrl", "");
    loadOnboarding();
  });
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  // Dev shortcut: Cmd/Ctrl+Shift+F12 → reset to onboarding
  globalShortcut.register("CommandOrControl+Shift+F12", () => {
    store.set("onboardingComplete", false);
    store.set("apiUrl", "");
    store.set("dashboardUrl", "");
    store.set("system", {});
    store.set("tunnel", undefined);
    loadOnboarding();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
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
  return store.getAll();
});

// ─── IPC: App metadata ──────────────────────────────────────────────────────

ipcMain.handle("app:version", () => {
  return app.getVersion();
});

ipcMain.handle("app:cloud-urls", () => {
  return { api: CLOUD_API_URL, dashboard: CLOUD_DASHBOARD_URL };
});

ipcMain.handle("app:local-urls", () => {
  return { api: LOCAL_API_URL, dashboard: LOCAL_DASHBOARD_URL };
});

// ─── IPC: Navigation ────────────────────────────────────────────────────────

ipcMain.handle("navigate", (_event, url: string) => {
  if (mainWindow) {
    mainWindow.loadURL(url);
  }
});

// ─── IPC: Onboarding ────────────────────────────────────────────────────────

ipcMain.handle(
  "onboarding:complete",
  async (
    _event,
    apiUrl: string,
    dashboardUrl: string,
    sshPayload?: SystemSettings,
    buildMode?: string,
  ) => {
    store.set("apiUrl", apiUrl);
    store.set("dashboardUrl", dashboardUrl);
    store.set("onboardingComplete", true);

    // Keep SSH creds locally as backup
    if (sshPayload) {
      store.set("system", sshPayload);
    }

    // Wait for the local API to be ready, then push settings
    const apiReady = await waitForApi(apiUrl);

    if (apiReady) {
      await pushInstanceSettings(apiUrl, {
        system: sshPayload,
        tunnel: store.get("tunnel"),
        buildMode,
        authMode: "none",
      });
    }

    // Navigate to desktop-login which creates a session cookie and
    // redirects to the dashboard.
    if (mainWindow) {
      mainWindow.loadURL(`${apiUrl}/api/auth/desktop-login`);
    }
    return true;
  }
);

/**
 * Cloud auth flow — "Continue with Cloud" in onboarding.
 *
 * 1. Wait for local API to be available
 * 2. Push authMode="cloud" to the local API
 * 3. Generate a random nonce and register it with the API
 * 4. Open cloud auth URL in the system browser
 * 5. Return immediately so the renderer can show polling UX
 * 6. Renderer polls via cloud-auth-poll until session is obtained
 */
ipcMain.handle("onboarding:cloud-auth", async () => {
  if (!mainWindow) return { ok: false, error: "No window" };

  // Wait for API to be available
  const apiReady = await waitForApi(LOCAL_API_URL);
  if (!apiReady) {
    return { ok: false, error: "api_unavailable" };
  }

  // Push authMode before auth so env returns "cloud"
  await pushInstanceSettings(LOCAL_API_URL, {
    authMode: "cloud",
    buildMode: "auto",
  });

  // Generate nonce, state (CSRF), and PKCE pair
  const nonce = randomBytes(16).toString("hex");
  const state = randomBytes(16).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  // Register with API (authenticated with internal token)
  try {
    const res = await net.fetch(`${LOCAL_API_URL}/api/auth/desktop-auth-start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": internalToken,
      },
      body: JSON.stringify({ nonce, state, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("nonce registration failed");
  } catch {
    return { ok: false, error: "nonce_registration_failed" };
  }

  // Open the authorize page in the system browser — if not logged in,
  // it redirects to login first, then back to authorize after auth.
  const callbackUrl = `${LOCAL_API_URL}/api/auth/cloud-callback`;
  const machine = hostname();
  const cloudAuthUrl = `${CLOUD_DASHBOARD_URL}/authorize?callback=${encodeURIComponent(callbackUrl)}&app=${encodeURIComponent("Openship Desktop")}&machine=${encodeURIComponent(machine)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}`;
  shell.openExternal(cloudAuthUrl);

  return { ok: true, cloudAuthUrl, nonce };
});

/**
 * Poll for cloud auth completion.
 *
 * Electron calls this every ~2 s after cloud-auth returns.
 * When the API reports "resolved", we navigate to the claim URL
 * which sets the cookie via HTTP Set-Cookie and redirects to the dashboard.
 */
ipcMain.handle("onboarding:cloud-auth-poll", async (_event, nonce: string) => {
  if (!mainWindow) return { status: "expired" };

  try {
    const res = await net.fetch(
      `${LOCAL_API_URL}/api/auth/desktop-auth-poll?nonce=${encodeURIComponent(nonce)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    const data = (await res.json()) as { status: string; claimCode?: string };

    if (data.status === "resolved" && data.claimCode) {
      // Navigate to the claim endpoint — it sets the cookie via HTTP
      // Set-Cookie header and redirects to the dashboard.
      const claimUrl = `${LOCAL_API_URL}/api/auth/desktop-claim?code=${encodeURIComponent(data.claimCode)}`;

      // Listen for dashboard load to mark onboarding complete
      const onNavigate = (_e: unknown, url: string) => {
        if (url.startsWith(LOCAL_DASHBOARD_URL)) {
          store.set("apiUrl", LOCAL_API_URL);
          store.set("dashboardUrl", LOCAL_DASHBOARD_URL);
          store.set("onboardingComplete", true);
          mainWindow?.webContents.removeListener("did-navigate", onNavigate);
        }
      };
      mainWindow.webContents.on("did-navigate", onNavigate);
      mainWindow.loadURL(claimUrl);

      return { status: "resolved" };
    }

    return { status: data.status };
  } catch {
    // Network error during poll — report as error so UI can show feedback
    return { status: "error" };
  }
});

// ─── Cloud reconnect from settings (no onboarding side-effects) ──────────────

/**
 * Start cloud connect flow from the settings page.
 *
 * Same PKCE + nonce mechanism as onboarding, but does NOT:
 *   - push authMode / buildMode changes
 *   - navigate the main window away
 *   - mark onboarding complete
 *
 * The cloud-callback endpoint stores the cloud session token server-side.
 * After polling resolves, the renderer just refreshes cloudApi.status().
 */
ipcMain.handle("cloud:connect", async () => {
  if (!mainWindow) return { ok: false, error: "No window" };

  const apiReady = await waitForApi(LOCAL_API_URL);
  if (!apiReady) {
    return { ok: false, error: "api_unavailable" };
  }

  // Generate nonce, state (CSRF), and PKCE pair
  const nonce = randomBytes(16).toString("hex");
  const state = randomBytes(16).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  // Register with API
  try {
    const res = await net.fetch(`${LOCAL_API_URL}/api/auth/desktop-auth-start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": internalToken,
      },
      body: JSON.stringify({ nonce, state, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("nonce registration failed");
  } catch {
    return { ok: false, error: "nonce_registration_failed" };
  }

  const callbackUrl = `${LOCAL_API_URL}/api/auth/cloud-callback`;
  const machine = hostname();
  const cloudAuthUrl = `${CLOUD_DASHBOARD_URL}/authorize?callback=${encodeURIComponent(callbackUrl)}&app=${encodeURIComponent("Openship Desktop")}&machine=${encodeURIComponent(machine)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}`;
  shell.openExternal(cloudAuthUrl);

  return { ok: true, cloudAuthUrl, nonce };
});

/**
 * Poll cloud connect from settings.
 *
 * Unlike onboarding poll, when resolved this does NOT navigate the window.
 * The cloud-callback has already stored the session token server-side.
 * The renderer should call cloudApi.status() to pick up the new state.
 */
ipcMain.handle("cloud:connect-poll", async (_event, nonce: string) => {
  if (!mainWindow) return { status: "expired" };

  try {
    const res = await net.fetch(
      `${LOCAL_API_URL}/api/auth/desktop-auth-poll?nonce=${encodeURIComponent(nonce)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    const data = (await res.json()) as { status: string; claimCode?: string };

    if (data.status === "resolved") {
      // Cloud session token is already stored server-side by cloud-callback.
      // No need to navigate or claim — just tell the renderer to refresh status.
      return { status: "resolved" };
    }

    return { status: data.status };
  } catch {
    return { status: "error" };
  }
});

ipcMain.handle("onboarding:open-external", (_event, url: string) => {
  shell.openExternal(url);
});

ipcMain.handle("onboarding:browse-file", async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Select SSH Key",
    properties: ["openFile"],
    filters: [{ name: "All Files", extensions: ["*"] }],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

ipcMain.handle("system:browse-folder", async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Select Project Folder",
    properties: ["openDirectory"],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// ─── IPC: System settings (synced to API) ────────────────────────────────────

ipcMain.handle("system:get-settings", async () => {
  // Read from API (source of truth), fall back to local ConfigStore
  const apiUrl = store.get("apiUrl");
  if (apiUrl) {
    try {
      const res = await net.fetch(`${apiUrl}/api/system/setup`, {
        headers: { "X-Internal-Token": internalToken },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        if (data.configured) return data;
      }
    } catch {
      // API unreachable — fall back to local copy
    }
  }
  return store.get("system") ?? {};
});

ipcMain.handle(
  "system:update-settings",
  async (_event, settings: Partial<SystemSettings>) => {
    // Update local ConfigStore
    const current = store.get("system") ?? {};
    store.set("system", { ...current, ...settings });

    // Also push to API so both stores stay in sync
    const apiUrl = store.get("apiUrl");
    if (apiUrl) {
      try {
        await net.fetch(`${apiUrl}/api/system/setup`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Token": internalToken,
          },
          body: JSON.stringify(settings),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Non-blocking — local copy is saved either way
      }
    }
    return true;
  }
);

// ─── IPC: Reset (for settings → re-onboard) ─────────────────────────────────

ipcMain.handle("app:reset", () => {
  store.set("onboardingComplete", false);
  store.set("apiUrl", "");
  store.set("dashboardUrl", "");
  store.set("system", {});
  store.set("tunnel", undefined);
  loadOnboarding();
  return true;
});
