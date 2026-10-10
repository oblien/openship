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

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics, reportError } from "@repo/core/diagnostics";
import { installNodeErrorReporting } from "@repo/core/diagnostics/node";
import { app, BrowserWindow, shell, ipcMain, net, dialog, globalShortcut, screen, nativeTheme } from "electron";
import { observeIpcHandler } from "./ipc-errors";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  CLOUD_API_URL as DEFAULT_CLOUD_API_URL,
  CLOUD_DASHBOARD_URL as DEFAULT_CLOUD_DASHBOARD_URL,
  DESKTOP_INSTANCE_SCHEME,
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
import { buildAppMenu } from "./menu";
import { buildLoadingScreen, type LoadingStage } from "./loading-screen";
import { closeSelfHostPrompt, openSelfHostPrompt } from "./selfhost-window";
import {
  classifyFrameNavigation,
  isAllowedFrameUrl,
  isRendererConfigKey,
  isSafeExternalUrl,
  buildDesktopCloudAuthorizeUrl,
  parseSelfHostedDashboardUrl,
  resolveDesktopCloudTarget,
  type RendererConfigKey,
} from "./security";
import { InstanceLinkInbox, registerInstanceLinks } from "./instance-links";

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
  /** Origin of a self-hosted dashboard opened in a sandboxed window. */
  selfHostedDashboardUrl?: string;
  /** Reopen that dashboard on the next launch. */
  selfHostedActive?: boolean;
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

// Opt-in profile split. Unpackaged `electron .` otherwise shares the installed
// app's userData, including its Postgres cluster.
function applyUserDataOverride() {
  const override = process.env.OPENSHIP_USER_DATA_DIR?.trim();
  if (!override) return;
  app.setPath("userData", resolve(override));
}
applyUserDataOverride();
installNodeErrorReporting("desktop");
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
    errorDiagnostics.error("desktop/main/index", "[openship] Failed to push instance settings:", err);
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
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "desktop/main/index");
      // Not ready yet - keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─── Window management ───────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let servicesReady = false;
const instanceLinks = new InstanceLinkInbox();

function focusMainWindow() {
  if (!mainWindow && servicesReady) {
    createWindow();
    routeInitialView();
  }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notifyInstanceLink() {
  // The renderer only receives a notification. It reads the validated address
  // through the main-frame-only channel below and asks before connecting.
  mainWindow?.webContents.send("instance:link");
}

const ownsInstance = registerInstanceLinks(app, (value) => {
  if (instanceLinks.receive(value)) {
    focusMainWindow();
    notifyInstanceLink();
  }
}, focusMainWindow, process.argv);

/** The update found by the launch check, pending user action in the update window. */
let pendingUpdate: UpdateInfo | null = null;

/** The download/install currently running, or null. The single-flight lock that
 *  keeps concurrent triggers from each starting their own download. */
let updateInFlight: Promise<boolean> | null = null;

function createWindow() {
  const bounds = store.get("windowBounds");
  // Never open larger than the display (a previously-stored oversized bound, or
  // a small screen, would otherwise make the window bigger than the desktop).
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  // Default to a generous window, not the whole screen. Leaving a margin makes it
  // obvious the app is a window you can move and resize; it used to open
  // maximized on every fresh launch (see the maximize block below), which read as
  // the app forcing itself fullscreen.
  const width = Math.min(bounds?.width ?? 1440, screenW - 80);
  const height = Math.min(bounds?.height ?? 900, screenH - 80);
  // Only honour a stored position — a fresh launch centres instead of pinning to
  // the top-left corner.
  const hasStoredPosition = typeof bounds?.x === "number" && typeof bounds?.y === "number";

  mainWindow = new BrowserWindow({
    width,
    height,
    ...(hasStoredPosition ? { x: bounds?.x, y: bounds?.y } : { center: true }),
    minWidth: 800,
    minHeight: 560,
    title: "Openship",
    // The app draws its own header row (DesktopChrome in the dashboard), so no
    // platform gets an OS title-bar strip above it.
    //
    // macOS stays on `hiddenInset` rather than going fully frameless: that keeps
    // the REAL traffic lights, so the green-button fullscreen menu and hover
    // behaviour work as Mac users expect, and the window is still closable by
    // mouse if the renderer ever stalls. Windows/Linux have no equivalent, so
    // there we take the frame off and draw ─ □ ✕ ourselves.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          // Vertically centre the lights in the header row (--titlebar-h, 44px):
          // (44 - 12) / 2 ≈ 16. Keep in sync with that CSS var or they sit off-axis.
          trafficLightPosition: { x: 18, y: 16 },
        }
      : { frame: false }),
    // Initial native canvas, before CSS is available. Mirrors --th-bg-page:
    // desktop's system appearance resolves to dim on a dark OS, otherwise light.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141414" : "#f9f9f9",
    show: false, // Show after content is ready
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Helpers are bundled into the preload in development and release builds.
      sandbox: true,
    },
  });

  // Restore a maximized window only if the user actually left it maximized. This
  // was `!== false`, i.e. undefined counted as "maximize" — so every first launch
  // (and any launch after a config reset) opened fullscreen-wide regardless of the
  // sizing above.
  if (store.get("windowMaximized") === true) {
    mainWindow.maximize();
  }

  // Keep the renderer's restore icon honest: the window can be maximized by the
  // OS, a keyboard shortcut, or a double-click, none of which go through our IPC.
  const emitMaximized = (maximized: boolean) =>
    mainWindow?.webContents.send("window:maximized-change", maximized);
  mainWindow.on("maximize", () => emitMaximized(true));
  mainWindow.on("unmaximize", () => emitMaximized(false));

  // Same idea for the titlebar's back/forward arrows: most navigation happens
  // through links and the Next router, not our IPC, so push the real state after
  // every navigation instead of letting the renderer guess. `did-navigate-in-page`
  // is the one that fires for Next's client-side pushState routing.
  const emitNav = () => {
    const h = mainWindow?.webContents.navigationHistory;
    mainWindow?.webContents.send("window:nav-state-change", {
      canGoBack: h?.canGoBack() ?? false,
      canGoForward: h?.canGoForward() ?? false,
    });
  };
  mainWindow.webContents.on("did-navigate", emitNav);
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") reportError("Desktop renderer stopped unexpectedly", {
      source: "desktop", kind: "process", component: "renderer", code: "RENDERER_PROCESS_GONE", handled: true,
    });
  });
  mainWindow.webContents.on("did-navigate-in-page", emitNav);

  // Show the window once content is painted (avoids white flash)
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Paint a loading splash immediately. The real view (onboarding/dashboard)
  // is routed by routeInitialView() once the local services are ready.
  showLoading();

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Keep the main frame on our own origins. Electron re-attaches the preload
  // `contextBridge` to whatever the frame navigates to — `window.desktop` is not
  // origin-scoped — so without this, one script primitive in the dashboard (which
  // renders repo names, server hostnames and build logs) could point the frame at
  // an attacker origin and inherit the whole native bridge.
  //
  // An off-origin http(s) target is handed to the system browser rather than just
  // dropped: plenty of dashboard links (docs, github.com/settings/tokens/new) have
  // no target="_blank", so they arrive here rather than at setWindowOpenHandler,
  // and silently doing nothing would break them. Same destination as before, in a
  // browser instead of inside the app frame.
  //
  // Resolve the origins per-event, never at registration: startLocalServices()
  // rewrites them with the dynamically bound ports after this window exists.
  const containNavigation = (e: Electron.Event, url: string) => {
    const verdict = classifyFrameNavigation(url, [
      getLocalDashboardUrl(),
      getLocalApiUrl(),
    ]);
    if (verdict === "allow") return;
    e.preventDefault();
    if (verdict === "external") shell.openExternal(url);
    else errorDiagnostics.warn("desktop/main/index", `[security] blocked main-frame navigation to ${url}`);
  };
  mainWindow.webContents.on("will-navigate", containNavigation);
  mainWindow.webContents.on("will-redirect", containNavigation);

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

let currentLoadingStage: LoadingStage = "launch";

function showLoading() {
  const window = mainWindow;
  if (!window) return;
  currentLoadingStage = "launch";
  const html = buildLoadingScreen({
    dark: nativeTheme.shouldUseDarkColors,
    version: app.getVersion(),
    windowControls: process.platform !== "darwin",
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .then(() => {
      // Services can start before the first document is ready to receive updates.
      if (mainWindow === window) setLoadingStage(currentLoadingStage);
    })
    .catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "desktop/main/index");
    }); // Dashboard navigation may already have replaced the splash.
}

/** Actual startup milestones; a progress update must never block launch. */
function setLoadingStage(stage: LoadingStage) {
  currentLoadingStage = stage;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void mainWindow.webContents
    .executeJavaScript(`window.__osStage && window.__osStage(${JSON.stringify(stage)})`)
    .catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "desktop/main/index");
    });
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
  setLoadingStage("dashboard");
  if (!ONBOARDING_ENABLED || store.get("onboardingComplete")) {
    loadDashboard();
  } else {
    loadOnboarding();
  }
}

async function connectSelfHosted(raw: unknown): Promise<{ ok: true; origin: string } | { ok: false; error: string }> {
  if (typeof raw !== "string") return { ok: false, error: "Enter the instance URL." };
  const target = parseSelfHostedDashboardUrl(raw);
  if (!target) {
    return { ok: false, error: "Use https. http is only allowed for localhost or 127.0.0.1." };
  }
  store.set("selfHostedDashboardUrl", target.origin);
  const started = await beginDesktopCloudConnect(target.origin);
  if (!started.ok) {
    const message =
      started.error === "api_unavailable"
        ? "The local API is not running, so sign-in cannot finish."
        : started.error === "nonce_registration_failed"
          ? "The local API did not accept this sign-in."
          : "Connection failed";
    return { ok: false, error: message };
  }
  closeSelfHostPrompt();
  return { ok: true, origin: target.origin };
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
      errorDiagnostics.error("desktop/main/index", "[openship] Dashboard failed to load:", err);
    }
  });
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  // Packaged macOS also declares the scheme in Info.plist. Do not register a
  // development executable over the user's installed Desktop application.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DESKTOP_INSTANCE_SCHEME);
  createWindow(); // shows the loading splash immediately

  // Native menu: Reload / Developer Tools / Help. Registered on every platform —
  // Windows/Linux are frameless so no menu bar renders, but the accelerators
  // (Ctrl+R, Ctrl+Shift+I) still install, and the titlebar keeps a ⋯ there.
  buildAppMenu(() => mainWindow, {
    connectSelfHosted: () => {
      openSelfHostPrompt(store.get("selfHostedDashboardUrl") || "");
    },
    useLocalInstance: () => {
      store.set("selfHostedActive", false);
      closeSelfHostPrompt();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        loadDashboard();
      }
    },
  });

  // In a packaged build there are no external dev servers — boot the bundled
  // API + dashboard ourselves before routing to the real view. In dev the
  // servers run via `bun dev`, so we skip straight to routing.
  if (app.isPackaged) {
    try {
      setLoadingStage("services");
      await startLocalServices(internalToken);
    } catch (err) {
      observeCaughtError(err, "desktop/main/index");
      dialog.showErrorBox(
        "Openship failed to start",
        err instanceof Error ? err.message : String(err),
      );
      app.quit();
      return;
    }
  }
  servicesReady = true;
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
        // Auto-install: the user opted IN to always taking updates, so this is
        // not an interruption — advisory or not, download + install straight
        // away. Progress streams to the dashboard's top surface (no modal).
        await runUpdate();
      } else if (notify && result.announcement) {
        // Notify-only (the default): the modal appears ONLY when the release
        // advisory says so (`bun run release … publish` writes `announce`). A
        // newer version on its own is NOT a reason to interrupt anyone — routine
        // releases go out often, and a modal on every launch trains people to
        // dismiss the one that actually matters. Unannounced releases stay
        // discoverable in Settings → Updates and the home Updates block.
        openUpdateWindow(mainWindow, result);
      }
      // Muted, or no announcement → stay silent here. The dashboard still
      // surfaces matching advisories on its own (critical ones always).
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
const handleIpc: typeof ipcMain.handle = (channel, listener) => {
  ipcMain.handle(channel, observeIpcHandler(channel, listener));
};

app.on("before-quit", () => {
  stopLocalServices();
});

// ─── IPC: Desktop invitations ─────────────────────────────────────────────────

function isInstanceLinkReader(event: Electron.IpcMainInvokeEvent): boolean {
  return !!mainWindow && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    isAllowedFrameUrl(event.senderFrame.url, [getLocalDashboardUrl()]);
}

handleIpc("instance:pending-link", (event) =>
  isInstanceLinkReader(event) ? instanceLinks.pending() : null,
);
handleIpc("instance:acknowledge-link", (event, id: unknown) => {
  if (!isInstanceLinkReader(event) || !instanceLinks.acknowledge(id)) return false;
  notifyInstanceLink();
  return true;
});

// ─── IPC: Updates ─────────────────────────────────────────────────────────────

/** Ensure `pendingUpdate` reflects the latest release. The boot check used to be
 *  the ONLY writer, so a release published after launch (or an offline-at-boot
 *  check) left it null and the dashboard's "Update now" hit a silent no-op that
 *  only a restart fixed. Re-check on demand here so the button + native wizard
 *  work without a restart. `checkForUpdate` never throws. */
async function ensurePendingUpdate(): Promise<void> {
  if (pendingUpdate) return;
  const result = await checkForUpdate({ force: true });
  pendingUpdate = result.available ? result : null;
}

handleIpc("update:dismiss", () => {
  closeUpdateWindow();
  return true;
});

// Re-check GitHub on demand and stage the result — drives the dashboard's
// "Check now" so a check happens without a restart. Returns the check result so
// the renderer can reflect it.
handleIpc("update:check", async (_event, force?: boolean) => {
  const result = await checkForUpdate({ force: force === true });
  // A successful check can invalidate an old offer. A failed network read
  // says nothing about the installer we already staged.
  if (result.latest) pendingUpdate = result.available ? result : null;
  return result;
});

// Open the native update window on demand (the dashboard's "Update now"). Stages
// the pending update first, so it works even when the boot check found nothing.
handleIpc("update:open", async () => {
  await ensurePendingUpdate();
  if (!pendingUpdate) return false;
  openUpdateWindow(mainWindow, pendingUpdate);
  return true;
});

/** Single-flight guard over performUpdate. Every trigger funnels here — the
 *  dashboard's beginUpdate() (update:start), the native modal's "Update now"
 *  (also update:start), and the boot auto-update. Without coalescing, two
 *  presses launch two downloadUpdate() calls that write the SAME temp file and
 *  stream two progress tracks at once (the 33%-and-15% race). A concurrent call
 *  now attaches to the run already in flight. The lock clears on failure so a
 *  retry works; on success the app quits + relaunches, so nothing is left to
 *  unlock. */
function runUpdate(): Promise<boolean> {
  if (updateInFlight) return updateInFlight;
  updateInFlight = performUpdate().finally(() => {
    updateInFlight = null;
  });
  return updateInFlight;
}

/** Download + install the pending update. The moment the download starts we
 *  hand the UI off to the dashboard's top-of-page update surface: the small
 *  native modal closes and progress streams into the main window instead, so
 *  the bar lives in the header the user already has — not stuck in the modal.
 *  Shared by the user-initiated IPC handler and the auto-update path. */
async function performUpdate(): Promise<boolean> {
  await ensurePendingUpdate();
  if (!pendingUpdate) return false;
  // Close the notify modal — from here on progress belongs to the dashboard.
  closeUpdateWindow();
  try {
    const file = await downloadUpdate(pendingUpdate.asset, pendingUpdate.version, (f) => {
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
    observeCaughtError(err, "desktop/main/index");
    mainWindow?.setProgressBar(-1);
    mainWindow?.webContents.send(
      "update:error",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

handleIpc("update:start", () => runUpdate());

// ─── IPC: Window controls ───────────────────────────────────────────────────
//
// Drives the app's own header row (DesktopChrome). Only Windows/Linux render
// buttons — macOS keeps its native traffic lights — but all four are registered
// on every platform so the renderer never branches on process.platform.

handleIpc("window:minimize", () => {
  mainWindow?.minimize();
  return true;
});

handleIpc("window:toggle-maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

handleIpc("window:close", () => {
  // close(), not destroy() — the existing "close" handler persists window bounds
  // and decides hide-vs-quit per platform.
  mainWindow?.close();
  return true;
});

handleIpc("window:is-maximized", () => mainWindow?.isMaximized() ?? false);

// ─── IPC: In-app navigation (titlebar back / forward / reload) ──────────────
//
// Driven from the main process rather than the renderer's own `history` API,
// because only Electron can answer canGoBack/canGoForward: `history.length`
// counts forward entries too and never shrinks, so the renderer cannot tell when
// to disable an arrow. Next's client-side routing pushes real history entries, so
// this covers SPA navigation as well as full page loads.

/** Electron 40 moved navigation history onto `webContents.navigationHistory`. */
function navHistory() {
  return mainWindow?.webContents.navigationHistory;
}

function navState(): { canGoBack: boolean; canGoForward: boolean } {
  const h = navHistory();
  return { canGoBack: h?.canGoBack() ?? false, canGoForward: h?.canGoForward() ?? false };
}

handleIpc("window:nav-back", () => {
  const h = navHistory();
  if (h?.canGoBack()) h.goBack();
  return navState();
});

handleIpc("window:nav-forward", () => {
  const h = navHistory();
  if (h?.canGoForward()) h.goForward();
  return navState();
});

handleIpc("window:reload", () => {
  mainWindow?.webContents.reload();
  return true;
});

handleIpc("window:nav-state", () => navState());

/**
 * Toggle DevTools from the titlebar's ⋯ menu.
 *
 * This is the ONLY route on Windows/Linux: those run `frame: false`, so there is
 * no menu bar at all. macOS still has Electron's default application menu (main
 * never calls Menu.setApplicationMenu, so the built-in one with View → Toggle
 * Developer Tools stays), but it lives in the system menu bar — having it in the
 * window too costs nothing and keeps the two platforms behaving the same.
 */
handleIpc("window:toggle-devtools", () => {
  const wc = mainWindow?.webContents;
  if (!wc) return false;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: "right" });
  return wc.isDevToolsOpened();
});

// ─── IPC: Config store ───────────────────────────────────────────────────────

// Update preferences only — see RENDERER_CONFIG_KEYS. The store also holds
// `system` (SSH host/user/password/passphrase) and `tunnel` tokens, so a generic
// key passthrough would let any script in the loaded content read local
// credentials off the bridge. There is deliberately no `getAll`.
handleIpc("config:get", (_event, key: unknown) => {
  if (!isRendererConfigKey(key)) {
    errorDiagnostics.warn("desktop/main/index", `[security] blocked config:get for non-exposed key ${String(key)}`);
    return undefined;
  }
  return store.get(key);
});

handleIpc("config:set", (_event, key: unknown, value: unknown) => {
  if (!isRendererConfigKey(key)) {
    errorDiagnostics.warn("desktop/main/index", `[security] blocked config:set for non-exposed key ${String(key)}`);
    return false;
  }
  store.set(key, value as AppConfig[RendererConfigKey]);
  return true;
});

// ─── IPC: App metadata ──────────────────────────────────────────────────────

handleIpc("app:version", () => {
  return app.getVersion();
});

handleIpc("app:cloud-urls", () => {
  return { api: CLOUD_API_URL, dashboard: CLOUD_DASHBOARD_URL };
});

handleIpc("app:local-urls", () => {
  return { api: getLocalApiUrl(), dashboard: getLocalDashboardUrl() };
});

// No renderer-driven navigation channel: `loadURL` from main bypasses the
// `will-navigate` allowlist in createWindow(), so exposing one would have handed
// the frame (and with it the native bridge) to any caller-supplied URL. Every
// in-frame navigation below is main-initiated to an origin we own.

// ─── IPC: Onboarding ────────────────────────────────────────────────────────

handleIpc(
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
handleIpc("onboarding:cloud-auth", async () => {
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
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "desktop/main/index");
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
handleIpc("onboarding:cloud-auth-poll", async (_event, nonce: string) => {
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
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "desktop/main/index");
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
async function beginDesktopCloudConnect(rawUrl?: string): Promise<
  { ok: true; cloudAuthUrl: string; nonce: string } | { ok: false; error: string }
> {
  if (!mainWindow) return { ok: false, error: "No window" };
  const target = resolveDesktopCloudTarget(rawUrl, CLOUD_DASHBOARD_URL);
  if ("error" in target) return { ok: false, error: target.error };

  const apiReady = await waitForApi(getLocalApiUrl());
  if (!apiReady) return { ok: false, error: "api_unavailable" };

  const nonce = randomBytes(16).toString("hex");
  const state = randomBytes(16).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  try {
    const res = await net.fetch(`${getLocalApiUrl()}/api/auth/desktop-auth-start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": internalToken,
      },
      body: JSON.stringify({
        nonce,
        state,
        code_verifier: codeVerifier,
        ...(target.apiOrigin ? { api_url: target.apiOrigin } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("nonce registration failed");
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "desktop/main/index");
    return { ok: false, error: "nonce_registration_failed" };
  }

  const cloudAuthUrl = buildDesktopCloudAuthorizeUrl({
    dashboardOrigin: target.dashboardOrigin,
    callbackUrl: `${getLocalApiUrl()}/api/auth/cloud-callback`,
    state,
    codeChallenge,
    machine: hostname(),
  });
  shell.openExternal(cloudAuthUrl);
  return { ok: true, cloudAuthUrl, nonce };
}

handleIpc("cloud:connect", async (_event, rawUrl?: unknown) => {
  return beginDesktopCloudConnect(typeof rawUrl === "string" ? rawUrl : undefined);
});

/**
 * Poll cloud connect from settings.
 *
 * Unlike onboarding poll, when resolved this does NOT navigate the window.
 * The cloud-callback has already stored the session token server-side.
 * The renderer should call cloudApi.status() to pick up the new state.
 */
handleIpc("cloud:connect-poll", async (_event, nonce: string) => {
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
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "desktop/main/index");
    return { status: "error" };
  }
});

// http/https only. `shell.openExternal` hands the string to the OS dispatcher,
// so an unvalidated scheme could launch a local handler or, on Windows, resolve a
// UNC path and leak an NTLM hash outbound.
handleIpc("onboarding:open-external", (_event, url: string) => {
  if (!isSafeExternalUrl(url)) {
    errorDiagnostics.warn("desktop/main/index", `[security] refused openExternal for ${url}`);
    return;
  }
  shell.openExternal(url);
});

handleIpc("onboarding:browse-file", async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    // showHiddenFiles or the dialog can't reach ~/.ssh, where the key it asks
    // for actually lives.
    properties: ["openFile", "showHiddenFiles"],
    title: "Select SSH Key",
    filters: [{ name: "All Files", extensions: ["*"] }],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

handleIpc("system:browse-folder", async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Select Project Folder",
    properties: ["openDirectory"],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// Same dialog as onboarding:browse-file, reachable from the dashboard's
// add-server form. Desktop is the mode where an SSH key really is a file on THIS
// machine, so a native dialog is the only picker that makes sense — the API reads
// the path off this same filesystem. `showHiddenFiles` because the key lives in
// ~/.ssh, which the dialog hides by default.
handleIpc("system:browse-file", async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Select SSH Key",
    properties: ["openFile", "showHiddenFiles"],
    filters: [{ name: "All Files", extensions: ["*"] }],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// ─── IPC: System settings ────────────────────────────────────────────────────
//
// SSH credentials are deliberately NOT reachable from the renderer. There is no
// read channel (the old one returned sshPassword/sshKeyPassphrase straight to the
// page) and no write channel (which could have repointed the managed server).
// The dashboard reads server settings from the API under a real session instead;
// onboarding still supplies its SSH payload through `onboarding:complete`, which
// pushes it to the API server-side.

// ─── IPC: Reset (for settings → re-onboard) ─────────────────────────────────

handleIpc("selfhost:connect", (_event, raw: unknown) => connectSelfHosted(raw));

handleIpc("selfhost:disconnect", () => {
  store.set("selfHostedActive", false);
  closeSelfHostPrompt();
  return { ok: true };
});

handleIpc("selfhost:status", () => ({
  active: store.get("selfHostedActive") === true,
  origin: store.get("selfHostedDashboardUrl") ?? "",
  open: false,
}));

handleIpc("selfhost:open-prompt", () => {
  openSelfHostPrompt(store.get("selfHostedDashboardUrl") || "");
  return { ok: true };
});

handleIpc("selfhost:cancel-prompt", () => {
  closeSelfHostPrompt();
  return { ok: true };
});

handleIpc("app:reset", () => {
  store.set("onboardingComplete", false);
  store.set("apiUrl", "");
  store.set("dashboardUrl", "");
  store.set("system", {});
  store.set("tunnel", undefined);
  loadOnboarding();
  return true;
});
