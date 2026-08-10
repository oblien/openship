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
import { buildAppMenu } from "./menu";

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

/**
 * Inline splash shown while the bundled services boot (packaged app).
 *
 * This is the app's FIRST screen, so it carries the brand mark (the Openship
 * ring) over the same node-graph motif the dashboard's first-run state uses —
 * hub wired to repo / services / data / domain, with the links animating as it
 * comes up. That reads as "connecting", which is what's actually happening, so
 * there's no generic spinner.
 *
 * Colours come from `prefers-color-scheme`, which Electron drives from
 * `nativeTheme` — the same source as the BrowserWindow's `backgroundColor`
 * above, so the splash can't be a white flash inside a black window (it was).
 * Dark uses #000 to match that window background exactly, with no seam.
 */
const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{color-scheme:light dark;
    --bg:#ffffff;--fg:#0f0f0f;--dim:rgba(0,0,0,.55);
    --line:rgba(0,0,0,.14);--tile:rgba(0,0,0,.035);--glyph:rgba(0,0,0,.30);--ok:#16a34a;--glow:rgba(0,0,0,.035)}
  @media (prefers-color-scheme: dark){
    :root{--bg:#000000;--fg:#f5f5f5;--dim:rgba(255,255,255,.5);
      --line:rgba(255,255,255,.16);--tile:rgba(255,255,255,.045);--glyph:rgba(255,255,255,.34);--ok:#22c55e;--glow:rgba(255,255,255,.045)}
  }
  body::before{content:"";position:fixed;inset:0;pointer-events:none;
    background:radial-gradient(60% 55% at 50% 45%,var(--glow),transparent 70%)}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;
    align-items:center;justify-content:center;overflow:hidden}
  .box{text-align:center;animation:rise .6s cubic-bezier(.2,.7,.2,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  /* Fixed, modest size — a splash mark, not a poster. Scaling with the viewport
     (68vw) made it fill half a desktop window. Only clamps on a tiny window. */
  svg{display:block;width:min(300px,72vw);height:auto;margin:0 auto 20px}

  /* Links flow inward — dash period (10) == offset, so the loop is seamless. */
  .link{stroke:var(--line);stroke-width:1.5;fill:none;stroke-dasharray:5 5;
    animation:flow 1.2s linear infinite}
  @keyframes flow{to{stroke-dashoffset:-10}}

  /* Each service "comes online" in turn: the tiles brighten around the ring. */
  .node{animation:wake 3.2s ease-in-out infinite}
  .node:nth-of-type(2){animation-delay:.4s}
  .node:nth-of-type(3){animation-delay:.8s}
  .node:nth-of-type(4){animation-delay:1.2s}
  @keyframes wake{0%,55%,100%{opacity:.45}22%{opacity:1}}
  .led{fill:var(--ok);opacity:0;animation:led 3.2s ease-in-out infinite}
  .pkt{fill:var(--ok);opacity:0}
  .node:nth-of-type(2) .led{animation-delay:.4s}
  .node:nth-of-type(3) .led{animation-delay:.8s}
  .node:nth-of-type(4) .led{animation-delay:1.2s}
  @keyframes led{0%,55%,100%{opacity:0}22%{opacity:1}}
  .tile{fill:var(--tile);stroke:var(--line);stroke-width:1.25}
  .glyph{stroke:var(--glyph);stroke-width:1.75;fill:none;stroke-linecap:round}

  /* The brand ring is the loading indicator — no spinner needed. */
  .halo{fill:none;stroke:var(--fg);stroke-width:1;opacity:.10;
    animation:halo 2.4s ease-out infinite;transform-origin:140px 62px}
  @keyframes halo{0%{transform:scale(.8);opacity:.16}70%,100%{transform:scale(1.35);opacity:0}}
  .mark{fill:none;stroke:var(--fg);stroke-width:5;opacity:.28}
  /* Real progress, drawn on the brand ring itself. dasharray = 2*pi*r (r=24);
     fill-box origin keeps the -90deg start at 12 o'clock without user-unit math. */
  .prog{fill:none;stroke:var(--ok);stroke-width:5;stroke-linecap:round;
    stroke-dasharray:150.8;stroke-dashoffset:150.8;
    transform-box:fill-box;transform-origin:center;transform:rotate(-90deg);
    transition:stroke-dashoffset .45s cubic-bezier(.3,.7,.2,1)}

  h1{font-size:15px;font-weight:500;letter-spacing:-.1px;margin:0;color:var(--fg);opacity:.85}
  .d{animation:blink 1.4s ease-in-out infinite;opacity:.25}
  .d:nth-child(2){animation-delay:.2s}
  .d:nth-child(3){animation-delay:.4s}
  @keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:.95}}
  @media (prefers-reduced-motion: reduce){
    .link,.node,.led,.halo,.mark,.d,.box{animation:none}
    .pkt{opacity:0}
    .prog{transition:none}
    .led{opacity:1}
  }
</style></head><body><div class="box">
  <svg viewBox="0 0 280 124" fill="none" aria-hidden="true">
    <!-- Tile edge (x=58 / 222) → ring edge (r=24 along each diagonal). -->
    <path class="link" d="M58 32 Q 92 40 117 53"/>
    <path class="link" d="M58 92 Q 92 84 117 71"/>
    <path class="link" d="M163 53 Q 188 40 222 32"/>
    <path class="link" d="M163 71 Q 188 84 222 92"/>

    <!-- Repo -->
    <g class="node">
      <rect class="tile" x="18" y="14" width="40" height="36" rx="11"/>
      <circle class="led" cx="50" cy="23" r="2.6"/>
      <circle class="glyph" cx="31" cy="39" r="3.5"/>
      <circle class="glyph" cx="45" cy="25" r="3.5"/>
      <path class="glyph" d="M31 35.5v-4a4 4 0 0 1 4-4h6"/>
    </g>
    <!-- Data -->
    <g class="node">
      <rect class="tile" x="18" y="74" width="40" height="36" rx="11"/>
      <circle class="led" cx="50" cy="83" r="2.6"/>
      <ellipse class="glyph" cx="38" cy="85" rx="9" ry="3.4"/>
      <path class="glyph" d="M29 85v10c0 1.9 4 3.4 9 3.4s9-1.5 9-3.4V85"/>
      <path class="glyph" d="M29 90.5c0 1.9 4 3.4 9 3.4s9-1.5 9-3.4"/>
    </g>
    <!-- Domain -->
    <g class="node">
      <rect class="tile" x="222" y="14" width="40" height="36" rx="11"/>
      <circle class="led" cx="254" cy="23" r="2.6"/>
      <circle class="glyph" cx="242" cy="32" r="9.5"/>
      <path class="glyph" d="M232.5 32h19M242 22.5c4.8 4.5 4.8 14.5 0 19M242 22.5c-4.8 4.5-4.8 14.5 0 19"/>
    </g>
    <!-- Services -->
    <g class="node">
      <rect class="tile" x="222" y="74" width="40" height="36" rx="11"/>
      <circle class="led" cx="254" cy="83" r="2.6"/>
      <rect class="glyph" x="232" y="84" width="20" height="15" rx="3"/>
      <path class="glyph" d="M238.5 84v15M245.5 84v15"/>
    </g>


    <!-- Packets travel tile → hub, one per link, staggered so something is
         always arriving. Paths are the links' shapes as deltas from cx/cy. -->
    <g class="pkts">
      <circle class="pkt" cx="58" cy="32" r="2.2">
        <animateMotion dur="2.6s" begin="0s" repeatCount="indefinite" path="M0 0 Q 34 8 59 21"/>
        <animate attributeName="opacity" dur="2.6s" begin="0s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.15;.8;1"/>
      </circle>
      <circle class="pkt" cx="58" cy="92" r="2.2">
        <animateMotion dur="2.6s" begin=".65s" repeatCount="indefinite" path="M0 0 Q 34 -8 59 -21"/>
        <animate attributeName="opacity" dur="2.6s" begin=".65s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.15;.8;1"/>
      </circle>
      <circle class="pkt" cx="222" cy="32" r="2.2">
        <animateMotion dur="2.6s" begin="1.3s" repeatCount="indefinite" path="M0 0 Q -34 8 -59 21"/>
        <animate attributeName="opacity" dur="2.6s" begin="1.3s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.15;.8;1"/>
      </circle>
      <circle class="pkt" cx="222" cy="92" r="2.2">
        <animateMotion dur="2.6s" begin="1.95s" repeatCount="indefinite" path="M0 0 Q -34 -8 -59 -21"/>
        <animate attributeName="opacity" dur="2.6s" begin="1.95s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.15;.8;1"/>
      </circle>
    </g>
    <circle class="halo" cx="140" cy="62" r="30"/>
    <circle class="mark" cx="140" cy="62" r="24"/>
    <circle class="prog" id="prog" cx="140" cy="62" r="24"/>
  </svg>
  <h1><span id="stage">Starting Openship</span><span class="d">.</span><span class="d">.</span><span class="d">.</span></h1>
</div>
<script>
  /* Progress on the ring. The main process reports the stage it has ACTUALLY
     reached plus a ceiling; between stages the arc eases toward that ceiling
     asymptotically (never touching it), so it always looks like work is
     happening but never claims a milestone that hasn't landed. */
  (function () {
    var C = 150.8, p = 0.05, ceiling = 0.22, arc = null, timer = null;
    function paint() {
      arc = arc || document.getElementById("prog");
      if (arc) arc.style.strokeDashoffset = String(C * (1 - p));
    }
    timer = setInterval(function () {
      if (p < ceiling) { p += (ceiling - p) * 0.09; paint(); }
    }, 180);
    /* text: what's happening. target: 0..1 ceiling; >=1 completes and stops. */
    window.__osStage = function (text, target) {
      var el = document.getElementById("stage");
      if (el && typeof text === "string" && text) el.textContent = text;
      if (typeof target !== "number") return;
      if (target >= 1) { clearInterval(timer); p = 1; } else { ceiling = target; }
      paint();
    };
    paint();
  })();
</script>
</body></html>`;

function showLoading() {
  if (!mainWindow) return;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
}

/**
 * Report boot progress to the splash: the caption, and a ceiling for the arc on
 * the brand ring.
 *
 * `ceiling` is where the arc is allowed to ease toward until the NEXT real
 * milestone — not where it jumps to. So the arc keeps moving during the long
 * wait (a parked arc reads as hung) while never claiming a stage that hasn't
 * landed. `1` completes it.
 *
 * The GRAPH stays ambient on purpose: desktop runs PGlite plus one bundled API
 * binary, so there is no per-node "postgres is up" truth to report, and lighting
 * tiles from invented milestones would be an animation that lies. Only the
 * caption and the arc are driven by real state.
 *
 * Fire-and-forget: the splash may already have been replaced by the dashboard
 * (or never loaded), and a failed progress update must never block launch.
 */
function setLoadingStage(text: string, ceiling?: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const args = ceiling === undefined ? JSON.stringify(text) : `${JSON.stringify(text)},${ceiling}`;
  void mainWindow.webContents
    .executeJavaScript(`window.__osStage && window.__osStage(${args})`)
    .catch(() => {});
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

  // Native menu: Reload / Developer Tools / Help. Registered on every platform —
  // Windows/Linux are frameless so no menu bar renders, but the accelerators
  // (Ctrl+R, Ctrl+Shift+I) still install, and the titlebar keeps a ⋯ there.
  buildAppMenu(() => mainWindow);

  // In a packaged build there are no external dev servers — boot the bundled
  // API + dashboard ourselves before routing to the real view. In dev the
  // servers run via `bun dev`, so we skip straight to routing.
  if (app.isPackaged) {
    try {
      // Ceilings, not positions: services are the long leg of the boot, so the
      // arc creeps to ~55% while they come up and completes when they're up.
      setLoadingStage("Starting services", 0.55);
      await startLocalServices(internalToken);
    } catch (err) {
      dialog.showErrorBox(
        "Openship failed to start",
        err instanceof Error ? err.message : String(err),
      );
      app.quit();
      return;
    }
    setLoadingStage("Opening dashboard", 1);
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

// ─── IPC: Window controls ───────────────────────────────────────────────────
//
// Drives the app's own header row (DesktopChrome). Only Windows/Linux render
// buttons — macOS keeps its native traffic lights — but all four are registered
// on every platform so the renderer never branches on process.platform.

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
  return true;
});

ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle("window:close", () => {
  // close(), not destroy() — the existing "close" handler persists window bounds
  // and decides hide-vs-quit per platform.
  mainWindow?.close();
  return true;
});

ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);

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

ipcMain.handle("window:nav-back", () => {
  const h = navHistory();
  if (h?.canGoBack()) h.goBack();
  return navState();
});

ipcMain.handle("window:nav-forward", () => {
  const h = navHistory();
  if (h?.canGoForward()) h.goForward();
  return navState();
});

ipcMain.handle("window:reload", () => {
  mainWindow?.webContents.reload();
  return true;
});

ipcMain.handle("window:nav-state", () => navState());

/**
 * Toggle DevTools from the titlebar's ⋯ menu.
 *
 * This is the ONLY route on Windows/Linux: those run `frame: false`, so there is
 * no menu bar at all. macOS still has Electron's default application menu (main
 * never calls Menu.setApplicationMenu, so the built-in one with View → Toggle
 * Developer Tools stays), but it lives in the system menu bar — having it in the
 * window too costs nothing and keeps the two platforms behaving the same.
 */
ipcMain.handle("window:toggle-devtools", () => {
  const wc = mainWindow?.webContents;
  if (!wc) return false;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: "right" });
  return wc.isDevToolsOpened();
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
