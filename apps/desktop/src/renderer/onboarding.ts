/**
 * Onboarding renderer — runs inside the BrowserWindow.
 *
 * Communicates with main process via `window.desktop` (exposed by preload).
 * Types are declared in ../types/desktop.d.ts
 */

// ─── DOM references ─────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const screens = {
  welcome: $("#screen-welcome"),
  connect: $("#screen-connect"),
  loading: $("#screen-loading"),
};

const els = {
  btnGetStarted: $("#btn-get-started"),
  btnBack: $("#btn-back"),
  btnConnect: $("#btn-connect"),
  btnCloud: $("#btn-cloud"),
  inputApiUrl: $<HTMLInputElement>("#input-api-url"),
  inputDashboardUrl: $<HTMLInputElement>("#input-dashboard-url"),
  connectStatus: $("#connect-status"),
  loadingMessage: $("#loading-message"),
  appVersion: $("#app-version"),
};

// ─── Screen navigation ──────────────────────────────────────────────────────

function showScreen(name: keyof typeof screens) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  // Show app version
  if (window.desktop) {
    const version = await window.desktop.app.version();
    els.appVersion.textContent = `v${version}`;
  }
}

// ─── Event handlers ──────────────────────────────────────────────────────────

els.btnGetStarted.addEventListener("click", () => {
  showScreen("connect");
});

els.btnBack.addEventListener("click", () => {
  showScreen("welcome");
});

els.btnCloud.addEventListener("click", async () => {
  if (window.desktop) {
    await window.desktop.onboarding.openExternal("https://app.openship.dev/register");
  }
});

els.btnConnect.addEventListener("click", async () => {
  const apiUrl = els.inputApiUrl.value.trim();
  if (!apiUrl) {
    showStatus("Please enter a server URL", "error");
    return;
  }

  // Validate URL format
  try {
    new URL(apiUrl);
  } catch {
    showStatus("That doesn't look like a valid URL", "error");
    return;
  }

  // Derive dashboard URL
  const dashboardUrl = els.inputDashboardUrl.value.trim() || apiUrl.replace(/:\d+$/, ":3001");

  // Show loading
  showScreen("loading");
  els.loadingMessage.textContent = "Verifying your server…";

  try {
    const result = await window.desktop.onboarding.testConnection(apiUrl);

    if (result.ok) {
      els.loadingMessage.textContent = "Connected! Launching dashboard…";
      await window.desktop.onboarding.complete(apiUrl, dashboardUrl);
      // Main process will navigate to the dashboard
    } else {
      showScreen("connect");
      showStatus(result.message || "Could not reach the server", "error");
    }
  } catch (err) {
    showScreen("connect");
    showStatus("Connection failed — check the URL and try again", "error");
  }
});

// Enter key triggers connect
els.inputApiUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.btnConnect.click();
});
els.inputDashboardUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.btnConnect.click();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showStatus(message: string, type: "error" | "success") {
  els.connectStatus.textContent = message;
  els.connectStatus.className = `status-message ${type}`;
  els.connectStatus.style.display = "block";
}

// ─── Boot ────────────────────────────────────────────────────────────────────
init();
