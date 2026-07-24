/**
 * Openship Desktop - Electron main process.
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

import { app, BrowserWindow, shell, ipcMain, net, dialog, globalShortcut, screen, nativeTheme } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  CLOUD_API_URL as DEFAULT_CLOUD_API_URL,
  CLOUD_DASHBOARD_URL as DEFAULT_CLOUD_DASHBOARD_URL,
} from "@repo/core";
import {
  type SystemSettings,
  type TunnelConfig,
  buildSetupPayload,
} from "@repo/onboarding";
import {
  getLocalApiUrl,
  getLocalDashboardUrl,
  startLocalServices,
  stopLocalServices,
  stopLocalServicesAndWait,
} from "./services";
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  type UpdateInfo,
} from "./updater";
import { closeUpdateWindow, openUpdateWindow } from "./update-window";

// ─── Persistent config ───────────────────────────────────────────────────────

/**
 * System settings - stored locally in the Electron config file.
 * SSH credentials and server connection details never leave the machine.
 * Platform preferences (build mode) are stored on the API server.
 *
 * Types imported from @repo/onboarding: SystemSettings, TunnelConfig
 */

interface AppConfig {
  /** URL of the Openship API server */
  apiUrl: string;
  /** URL of the dashboard */
  dashboardUrl: string;
  /** Whether onboarding has been completed */
  onboardingComplete: boolean;
  /** Window bounds for restore (normal/un-maximized bounds) */
  windowBounds?: { x: number; y: number; width: number; height: number };
  /** Whether the window was maximized last close (default full-window) */
  windowMaximized?: boolean;
  /** System-level settings - SSH creds, kept locally as backup */
  system?: SystemSettings;
  /** Tunnel configuration - pushed to API during onboarding */
  tunnel?: TunnelConfig;
  /** Auto-install updates without asking. Default OFF for security — the user
   *  stays in control and updates are only ever pulled from GitHub. */
  autoUpdate?: boolean;
  /** Show update + security-advisory notifications. Default ON. Muting hides
   *  everything EXCEPT critical advisories (those always surface once). */
  updateNotifications?: boolean;
  /** Highest version the "what's new" was shown for (post-update notice). */
  lastSeenVersion?: string;
  /** Advisory ids the user dismissed (non-critical only). */
  dismissedAdvisoryIds?: string[];
}

const defaults: AppConfig = {
  apiUrl: "",
  dashboardUrl: "",
  onboardingComplete: false,
  autoUpdate: false,
  updateNotifications: true,
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
 * Authenticated with the internal token - no user session needed.
 * Uses buildSetupPayload from @repo/onboarding for the payload shape.
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
  const payload = buildSetupPayload(settings);

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
    // Log but don't block - settings can be pushed again later
    console.error("[openship] Failed to push instance settings:", err);
  }
}

// ─── URL constants ───────────────────────────────────────────────────────────

const CLOUD_API_URL = DEFAULT_CLOUD_API_URL;
const CLOUD_DASHBOARD_URL = DEFAULT_CLOUD_DASHBOARD_URL;

// Local API/dashboard origins are DYNAMIC (chosen at launch by services.ts).
// Always read them live via getLocalApiUrl()/getLocalDashboardUrl() — never
// cache, since the ports differ each run.

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
      // Not ready yet - keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─── Window management ───────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

/** The update found by the launch check, pending user action in the update window. */
let pendingUpdate: UpdateInfo | null = null;

function createWindow() {
  const bounds = store.get("windowBounds");
  // Never open larger than the display (a previously-stored oversized bound, or
  // a small screen, would otherwise make the window bigger than the desktop).
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(bounds?.width ?? 1200, screenW);
  const height = Math.min(bounds?.height ?? 800, screenH);

  mainWindow = new BrowserWindow({
    width,
    height,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 800,
    minHeight: 560,
    title: "Openship",
    // Seamless native frame (like VS Code / Spotify): no OS title-bar strip,
    // traffic lights inlaid top-left. The dashboard reserves top-left space +
    // a drag region for them (see the `is-desktop` handling in the web app).
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Inset the traffic lights a touch further down/right so they sit inside the
    // window's rounded content area rather than hugging the corner. Kept in sync
    // with the dashboard's `--titlebar-h` reserved strip so they never overhang
    // page content.
    trafficLightPosition: { x: 22, y: 22 },
    // Match the OS appearance so there's no wrong-theme flash while the dashboard
    // loads (the web UI defaults to "system" in desktop). Dark bg is the app's
    // --th-bg-page dark value (#000000); light is #ffffff.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff",
    show: false, // Show after content is ready
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Full-window by default: maximize unless the user chose a non-maximized
  // size last time.
  if (store.get("windowMaximized") !== false) {
    mainWindow.maximize();
  }

  // Show the window once content is painted (avoids white flash)
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Paint a loading splash immediately. The real view (onboarding/dashboard)
  // is routed by routeInitialView() once the local services are ready.
  showLoading();

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Detect when onboarding completes via dashboard desktop-login redirect
  mainWindow.webContents.on("did-navigate", (_e, url) => {
    const u = new URL(url);
    // desktop-login redirects to dashboard root - mark onboarding complete
    if (!store.get("onboardingComplete") && u.pathname === "/" && u.origin === getLocalDashboardUrl()) {
      store.set("onboardingComplete", true);
      store.set("apiUrl", getLocalApiUrl());
      store.set("dashboardUrl", getLocalDashboardUrl());
    }
  });

  // Save window state on close. Store the NORMAL (un-maximized) bounds so a
  // maximized session doesn't persist a full-screen-sized "normal" window.
  mainWindow.on("close", () => {
    if (mainWindow) {
      store.set("windowMaximized", mainWindow.isMaximized());
      store.set("windowBounds", mainWindow.getNormalBounds());
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Loading strategies ──────────────────────────────────────────────────────

/** Minimal inline splash shown while the bundled services boot (packaged app). */
const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#ffffff;color:#0f0f0f;
    font-family:system-ui,-apple-system,sans-serif;display:flex;
    align-items:center;justify-content:center}
  .box{text-align:center}
  .spinner{width:28px;height:28px;margin:0 auto 16px;border-radius:50%;
    border:3px solid rgba(0,0,0,.12);border-top-color:#0f0f0f;
    animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{font-size:14px;opacity:.55;margin:0}
</style></head><body><div class="box">
  <div class="spinner"></div><p>Starting Openship…</p>
</div></body></html>`;

function showLoading() {
  if (!mainWindow) return;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
}

/**
 * First-run onboarding is OPT-IN — disabled by default, so the desktop app goes
 * straight to the dashboard (the instance is treated as already set up). Set
 * `OPENSHIP_ENABLE_ONBOARDING=1` (or `true`) to bring the onboarding wizard back.
 */
const ONBOARDING_ENABLED =
  process.env.OPENSHIP_ENABLE_ONBOARDING === "1" ||
  process.env.OPENSHIP_ENABLE_ONBOARDING === "true";

/** Decide the first real view once services are up: onboarding vs dashboard. */
function routeInitialView() {
  if (!ONBOARDING_ENABLED || store.get("onboardingComplete")) {
    loadDashboard();
  } else {
    loadOnboarding();
  }
}

function loadOnboarding() {
  if (!mainWindow) return;
  // Load the dashboard onboarding page - unified UI shared by desktop, CLI, and browser
  mainWindow.loadURL(`${getLocalDashboardUrl()}/onboarding`);
}

function loadDashboard() {
  if (!mainWindow) return;
  // Always use the LIVE dashboard origin — the port is dynamic per launch, so
  // any persisted dashboardUrl is stale. onboardingComplete is the real state.
  mainWindow.loadURL(getLocalDashboardUrl()).catch((err) => {
    // Fall back to onboarding on a dashboard-load failure only when onboarding
    // is enabled; otherwise it's just a transient dashboard error to surface.
    if (ONBOARDING_ENABLED) {
      store.set("onboardingComplete", false);
      loadOnboarding();
    } else {
      console.error("[openship] Dashboard failed to load:", err);
    }
  });
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow(); // shows the loading splash immediately

  // In a packaged build there are no external dev servers — boot the bundled
  // API + dashboard ourselves before routing to the real view. In dev the
  // servers run via `bun dev`, so we skip straight to routing.
  if (app.isPackaged) {
    try {
      await startLocalServices(internalToken);
    } catch (err) {
      dialog.showErrorBox(
        "Openship failed to start",
        err instanceof Error ? err.message : String(err),
      );
      app.quit();
      return;
    }
  }
  routeInitialView();

  // Background: ask GitHub if there's a newer release; if so, act per the user's
  // update settings. Never blocks launch — a failed/offline check resolves to
  // "no update". Data is only ever PULLED from GitHub; nothing pushes to us.
  if (app.isPackaged) {
    void checkForUpdate().then(async (result) => {
      if (!result.available) return;
      pendingUpdate = result;
      const autoUpdate = store.get("autoUpdate") === true;
      const notify = store.get("updateNotifications") !== false; // default ON

      if (autoUpdate) {
        // Auto-install: download + install straight away. Progress streams to
        // the dashboard's top-of-page surface (no modal needed).
        await runUpdate();
      } else if (notify) {
        // Notify-only (the default): offer it in the native modal, user decides.
        // On "Update now" the modal hands off to the header progress bar.
        openUpdateWindow(mainWindow, result);
      }
      // Muted + not auto → stay silent here. The dashboard still surfaces
      // matching advisories on its own (critical ones always).
    });
  }

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
      routeInitialView();
    }
  });
});

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Tear down the bundled services when the app actually quits.
app.on("before-quit", () => {
  stopLocalServices();
});

// ─── IPC: Updates ─────────────────────────────────────────────────────────────

/** Ensure `pendingUpdate` reflects the latest release. The boot check used to be
 *  the ONLY writer, so a release published after launch (or an offline-at-boot
 *  check) left it null and the dashboard's "Update now" hit a silent no-op that
 *  only a restart fixed. Re-check on demand here so the button + native wizard
 *  work without a restart. `checkForUpdate` never throws. */
async function ensurePendingUpdate(): Promise<void> {
  if (pendingUpdate) return;
  const result = await checkForUpdate();
  if (result.available) pendingUpdate = result;
}

ipcMain.handle("update:dismiss", () => {
  closeUpdateWindow();
  return true;
});

// Re-check GitHub on demand and stage the result — drives the dashboard's
// "Check now" so a check happens without a restart. Returns the check result so
// the renderer can reflect it.
ipcMain.handle("update:check", async () => {
  const result = await checkForUpdate();
  if (result.available) pendingUpdate = result;
  return result;
});

// Open the native update window on demand (the dashboard's "Update now"). Stages
// the pending update first, so it works even when the boot check found nothing.
ipcMain.handle("update:open", async () => {
  await ensurePendingUpdate();
  if (!pendingUpdate) return false;
  openUpdateWindow(mainWindow, pendingUpdate);
  return true;
});

/** Download + install the pending update. The moment the download starts we
 *  hand the UI off to the dashboard's top-of-page update surface: the small
 *  native modal closes and progress streams into the main window instead, so
 *  the bar lives in the header the user already has — not stuck in the modal.
 *  Shared by the user-initiated IPC handler and the auto-update path. */
async function runUpdate(): Promise<boolean> {
  await ensurePendingUpdate();
  if (!pendingUpdate) return false;
  // Close the notify modal — from here on progress belongs to the dashboard.
  closeUpdateWindow();
  try {
    const file = await downloadUpdate(pendingUpdate.asset, (f) => {
      mainWindow?.webContents.send("update:progress", f);
      mainWindow?.setProgressBar(f); // Dock / taskbar indicator
    });
    mainWindow?.webContents.send("update:done");
    mainWindow?.setProgressBar(-1); // clear
    // Wait for the old API to fully exit (releasing the PGlite lock) BEFORE the
    // new version launches — otherwise the fresh app races the still-draining
    // old process for the data dir and can fail to open it.
    await stopLocalServicesAndWait();
    installUpdate(file); // quits + relaunches on the new version (or opens installer)
    return true;
  } catch (err) {
    mainWindow?.setProgressBar(-1);
    mainWindow?.webContents.send(
      "update:error",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

ipcMain.handle("update:start", () => runUpdate());

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
  return { api: getLocalApiUrl(), dashboard: getLocalDashboardUrl() };
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
    _apiUrl: string,
    _dashboardUrl: string,
    sshPayload?: SystemSettings,
    buildMode?: string,
  ) => {
    // The main process owns the real (dynamic) local origins — don't trust the
    // renderer-supplied URLs.
    const apiUrl = getLocalApiUrl();
    store.set("apiUrl", apiUrl);
    store.set("dashboardUrl", getLocalDashboardUrl());
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
 * Cloud auth flow - "Continue with Cloud" in onboarding.
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
  const apiReady = await waitForApi(getLocalApiUrl());
  if (!apiReady) {
    return { ok: false, error: "api_unavailable" };
  }

  // Push authMode before auth so env returns "cloud"
  await pushInstanceSettings(getLocalApiUrl(), {
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
    const res = await net.fetch(`${getLocalApiUrl()}/api/auth/desktop-auth-start`, {
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

  // Open the authorize page in the system browser - if not logged in,
  // it redirects to login first, then back to authorize after auth.
  const callbackUrl = `${getLocalApiUrl()}/api/auth/cloud-callback`;
  const machine = hostname();
  const cloudAuthUrl = `${CLOUD_DASHBOARD_URL}/authorize?callback=${encodeURIComponent(callbackUrl)}&app=${encodeURIComponent("Openship Desktop")}&machine=${encodeURIComponent(machine)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}&flow=desktop-cloud`;
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
      `${getLocalApiUrl()}/api/auth/desktop-auth-poll?nonce=${encodeURIComponent(nonce)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    const data = (await res.json()) as { status: string; claimCode?: string };

    if (data.status === "resolved" && data.claimCode) {
      // Navigate to the claim endpoint - it sets the cookie via HTTP
      // Set-Cookie header and redirects to the dashboard.
      const claimUrl = `${getLocalApiUrl()}/api/auth/desktop-claim?code=${encodeURIComponent(data.claimCode)}`;

      // Listen for dashboard load to mark onboarding complete
      const onNavigate = (_e: unknown, url: string) => {
        if (url.startsWith(getLocalDashboardUrl())) {
          store.set("apiUrl", getLocalApiUrl());
          store.set("dashboardUrl", getLocalDashboardUrl());
          store.set("onboardingComplete", true);
          mainWindow?.webContents.removeListener("did-navigate", onNavigate);
        }
      };
      mainWindow.webContents.on("did-navigate", onNavigate);
      mainWindow.loadURL(claimUrl);

      // Bring the desktop app back to the front (the browser had focus for the
      // cloud sign-in) — like VS Code re-focusing after an external auth.
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      app.focus({ steal: true });

      return { status: "resolved" };
    }

    return { status: data.status };
  } catch {
    // Network error during poll - report as error so UI can show feedback
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

  const apiReady = await waitForApi(getLocalApiUrl());
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
    const res = await net.fetch(`${getLocalApiUrl()}/api/auth/desktop-auth-start`, {
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

  const callbackUrl = `${getLocalApiUrl()}/api/auth/cloud-callback`;
  const machine = hostname();
  const cloudAuthUrl = `${CLOUD_DASHBOARD_URL}/authorize?callback=${encodeURIComponent(callbackUrl)}&app=${encodeURIComponent("Openship Desktop")}&machine=${encodeURIComponent(machine)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}&flow=desktop-cloud`;
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
      `${getLocalApiUrl()}/api/auth/desktop-auth-poll?nonce=${encodeURIComponent(nonce)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    const data = (await res.json()) as { status: string; claimCode?: string };

    if (data.status === "resolved") {
      // Cloud session token is already stored server-side by cloud-callback.
      // No need to navigate or claim - just tell the renderer to refresh status.
      // Re-focus the desktop app (the browser had focus during sign-in).
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      app.focus({ steal: true });
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
  const apiUrl = getLocalApiUrl();
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
      // API unreachable - fall back to local copy
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
    const apiUrl = getLocalApiUrl();
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
        // Non-blocking - local copy is saved either way
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
