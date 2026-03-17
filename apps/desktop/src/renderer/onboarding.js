// Onboarding renderer — communicates with main process via window.desktop (exposed by preload).

var $ = function (sel) { return document.querySelector(sel); };

var screens = {
  choose: $("#screen-choose"),
  selfhostChoice: $("#screen-selfhost-choice"),
  selfhost: $("#screen-selfhost"),
  tunnel: $("#screen-tunnel"),
  preferences: $("#screen-preferences"),
  loading: $("#screen-loading"),
};

var els = {
  btnCloud: $("#btn-cloud"),
  btnSelfhost: $("#btn-selfhost"),
  btnBack: $("#btn-back"),
  btnConnect: $("#btn-connect"),
  inputServerIp: $("#input-server-ip"),
  inputServerUser: $("#input-server-user"),
  inputServerPassword: $("#input-server-password"),
  inputKeyPath: $("#input-key-path"),
  inputKeyPassphrase: $("#input-key-passphrase"),
  btnBrowseKey: $("#btn-browse-key"),
  btnAdvanced: $("#btn-advanced"),
  advancedPanel: $("#advanced-panel"),
  inputSshPort: $("#input-ssh-port"),
  inputJumpHost: $("#input-jump-host"),
  inputSshArgs: $("#input-ssh-args"),
  authTabs: document.querySelectorAll(".auth-tab"),
  authPanelPassword: $("#auth-password"),
  authPanelKey: $("#auth-key"),
  connectStatus: $("#connect-status"),
  loadingTitle: $("#loading-title"),
  loadingMessage: $("#loading-message"),
  loadingSpinner: $("#loading-spinner"),
  loadingActions: $("#loading-actions"),
  loadingBtnRetry: $("#loading-btn-retry"),
  loadingBtnOpen: $("#loading-btn-open"),
  loadingBtnBack: $("#loading-btn-back"),
  linkTutorial: $("#link-tutorial"),
  linkGithub: $("#link-github"),
  linkWebsite: $("#link-website"),
  appVersion: $("#app-version"),
};

var authMethod = "password";
var selectedBuildMode = "auto";
var selectedTunnel = "edge";
var tunnelReturnScreen = "selfhostChoice";

// Pending connection info — set before showing preferences, consumed on continue
var pendingApiUrl = "";
var pendingDashboardUrl = "";
var pendingSshPayload = null;
var prefReturnScreen = "choose";

function showScreen(name) {
  Object.values(screens).forEach(function (s) { s.classList.remove("active"); });
  screens[name].classList.add("active");
}

function showStatus(message, type) {
  els.connectStatus.textContent = message;
  els.connectStatus.className = "status-message " + type;
  els.connectStatus.style.display = "block";
}

function hideStatus() {
  els.connectStatus.style.display = "none";
}

// Init
(async function init() {
  if (window.desktop) {
    var version = await window.desktop.app.version();
    els.appVersion.textContent = "v" + version;
  }
})();

// Auth method toggle
els.authTabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    authMethod = tab.dataset.auth;
    els.authTabs.forEach(function (t) { t.classList.remove("active"); });
    tab.classList.add("active");
    els.authPanelPassword.classList.toggle("active", authMethod === "password");
    els.authPanelKey.classList.toggle("active", authMethod === "key");
    hideStatus();
  });
});

// Browse for SSH key file
els.btnBrowseKey.addEventListener("click", async function () {
  if (window.desktop && window.desktop.onboarding.browseFile) {
    var path = await window.desktop.onboarding.browseFile();
    if (path) els.inputKeyPath.value = path;
  }
});

// Advanced toggle
els.btnAdvanced.addEventListener("click", function () {
  els.btnAdvanced.classList.toggle("open");
  els.advancedPanel.classList.toggle("open");
});

// ─── Loading screen helpers ─────────────────────────────────────────────────

/** Reset loading screen to default spinner-only state */
function resetLoadingScreen() {
  els.loadingSpinner.style.display = "";
  els.loadingActions.classList.remove("visible");
  els.loadingBtnRetry.classList.remove("visible");
  els.loadingBtnOpen.classList.remove("visible");
  els.loadingBtnBack.classList.remove("visible");
  // Remove any previous click handlers
  els.loadingBtnRetry.onclick = null;
  els.loadingBtnOpen.onclick = null;
  els.loadingBtnBack.onclick = null;
}

/** Show specific action buttons on the loading screen */
function showLoadingActions(opts) {
  els.loadingSpinner.style.display = "none";
  els.loadingActions.classList.add("visible");
  if (opts.retry) {
    els.loadingBtnRetry.classList.add("visible");
    els.loadingBtnRetry.onclick = opts.retry;
  }
  if (opts.openUrl) {
    els.loadingBtnOpen.classList.add("visible");
    els.loadingBtnOpen.onclick = function () {
      window.desktop.onboarding.openExternal(opts.openUrl);
    };
  }
  if (opts.back) {
    els.loadingBtnBack.classList.add("visible");
    els.loadingBtnBack.onclick = opts.back;
  }
}

// Cloud — authenticate via Openship Cloud.
// Opens system browser for cloud auth, then polls for session completion.
var cloudAuthAborted = false;

async function startCloudAuth() {
  resetLoadingScreen();
  showScreen("loading");
  els.loadingTitle.textContent = "Launching Openship\u2026";
  els.loadingMessage.textContent = "Waiting for local services";

  var result = await window.desktop.onboarding.cloudAuth();

  if (!result.ok) {
    // API never became available or nonce registration failed
    els.loadingTitle.textContent = "Could not connect";
    els.loadingMessage.textContent =
      result.error === "api_unavailable"
        ? "The local API didn\u2019t respond. Make sure services are running."
        : result.error || "Something went wrong";
    showLoadingActions({
      retry: function () { startCloudAuth(); },
      back: function () { showScreen("choose"); },
    });
    return;
  }

  // System browser opened — show polling UX (spinner + action buttons)
  els.loadingTitle.textContent = "Waiting for sign in\u2026";
  els.loadingMessage.textContent = "Complete sign in in your browser";
  els.loadingSpinner.style.display = "";
  els.loadingActions.classList.add("visible");
  els.loadingBtnOpen.classList.add("visible");
  els.loadingBtnOpen.textContent = "Open in Browser";
  els.loadingBtnOpen.onclick = function () {
    window.desktop.onboarding.openExternal(result.cloudAuthUrl);
  };
  els.loadingBtnBack.classList.add("visible");
  cloudAuthAborted = false;
  els.loadingBtnBack.onclick = function () {
    cloudAuthAborted = true;
    showScreen("choose");
  };

  // Poll until session is obtained, expired, or user cancels
  var consecutiveErrors = 0;
  while (!cloudAuthAborted) {
    await new Promise(function (r) { setTimeout(r, 2000); });
    if (cloudAuthAborted) break;

    var poll = await window.desktop.onboarding.cloudAuthPoll(result.nonce);

    if (poll.status === "resolved") {
      // Main process set the cookie and loaded the dashboard — done
      return;
    }

    if (poll.status === "expired") {
      els.loadingTitle.textContent = "Session expired";
      els.loadingMessage.textContent = "The sign-in timed out. Please try again.";
      showLoadingActions({
        retry: function () { startCloudAuth(); },
        back: function () { showScreen("choose"); },
      });
      return;
    }

    if (poll.status === "error") {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        els.loadingTitle.textContent = "Connection lost";
        els.loadingMessage.textContent = "Could not reach the local API. Please try again.";
        showLoadingActions({
          retry: function () { startCloudAuth(); },
          back: function () { showScreen("choose"); },
        });
        return;
      }
    } else {
      consecutiveErrors = 0;
    }
    // "pending" — keep polling
  }
}

els.btnCloud.addEventListener("click", async function () {
  if (window.desktop) {
    startCloudAuth();
  }
});

// Self-host → show sub-choice (another server vs this machine)
els.btnSelfhost.addEventListener("click", function () {
  hideStatus();
  showScreen("selfhostChoice");
});

// Sub-choice: back to choose
$("#btn-selfhost-choice-back").addEventListener("click", function () {
  showScreen("choose");
});

// Sub-choice: another server → SSH form
$("#btn-choose-remote").addEventListener("click", function () {
  hideStatus();
  showScreen("selfhost");
});

// Sub-choice: this machine → tunnel choice (always needs tunnel)
$("#btn-choose-local").addEventListener("click", function () {
  // Local setup — API and dashboard run on localhost
  pendingApiUrl = "http://localhost:4000";
  pendingDashboardUrl = "http://localhost:3001";
  pendingSshPayload = null;
  selectedBuildMode = "local";
  tunnelReturnScreen = "selfhostChoice";
  showScreen("tunnel");
});

// Back from SSH form → sub-choice (not choose)
els.btnBack.addEventListener("click", function () {
  hideStatus();
  showScreen("selfhostChoice");
});

// External links
els.linkGithub.addEventListener("click", function () {
  window.desktop.onboarding.openExternal("https://github.com/oblien/openship");
});
els.linkWebsite.addEventListener("click", function () {
  window.desktop.onboarding.openExternal("https://openship.dev");
});

// Tutorial link
els.linkTutorial.addEventListener("click", function (e) {
  e.preventDefault();
  if (window.desktop) {
    window.desktop.onboarding.openExternal("https://docs.openship.dev/self-hosting");
  }
});

// Save self-hosted server details and continue
els.btnConnect.addEventListener("click", async function () {
  var ip = els.inputServerIp.value.trim();
  var user = els.inputServerUser.value.trim() || "root";

  if (!ip) {
    showStatus("Please enter your server IP address", "error");
    return;
  }

  // Basic IP / hostname validation
  if (!/^[\w.\-:]+$/.test(ip)) {
    showStatus("That doesn't look like a valid IP address", "error");
    return;
  }

  var authPayload = { method: authMethod, user: user };

  // Advanced options
  var port = els.inputSshPort.value.trim();
  if (port) authPayload.port = parseInt(port, 10) || 22;
  var jumpHost = els.inputJumpHost.value.trim();
  if (jumpHost) authPayload.jumpHost = jumpHost;
  var sshArgs = els.inputSshArgs.value.trim();
  if (sshArgs) authPayload.sshArgs = sshArgs;

  if (authMethod === "password") {
    var password = els.inputServerPassword.value;
    if (!password) {
      showStatus("Please enter your server password", "error");
      return;
    }
    authPayload.password = password;
  } else {
    var keyPath = els.inputKeyPath.value.trim();
    if (!keyPath) {
      showStatus("Please enter the path to your SSH key", "error");
      return;
    }
    authPayload.keyPath = keyPath;
    var passphrase = els.inputKeyPassphrase.value;
    if (passphrase) authPayload.passphrase = passphrase;
  }

  authPayload.host = ip;

  var localUrls = await window.desktop.app.localUrls();
  pendingApiUrl = localUrls.api;
  pendingDashboardUrl = localUrls.dashboard;
  pendingSshPayload = authPayload;

  // Detect private / LAN IP → needs tunnel
  if (isPrivateIp(ip)) {
    tunnelReturnScreen = "selfhost";
    showScreen("tunnel");
  } else {
    // Public IP — no tunnel needed, go to build preferences
    prefReturnScreen = "selfhost";
    showScreen("preferences");
  }
});

// Enter key triggers connect
els.inputServerIp.addEventListener("keydown", function (e) {
  if (e.key === "Enter") els.btnConnect.click();
});
els.inputServerPassword.addEventListener("keydown", function (e) {
  if (e.key === "Enter") els.btnConnect.click();
});

// ─── Tunnel choice screen ─────────────────────────────────────────────────────

// Build SSH system settings payload from pending connection data
function buildSshSettings() {
  if (!pendingSshPayload) return null;
  var settings = {
    sshHost: pendingSshPayload.host || pendingApiUrl.replace(/^https?:\/\//, "").replace(/:\d+$/, ""),
    sshPort: pendingSshPayload.port || 22,
    sshUser: pendingSshPayload.user || "root",
    sshAuthMethod: pendingSshPayload.method,
  };
  if (pendingSshPayload.password) settings.sshPassword = pendingSshPayload.password;
  if (pendingSshPayload.keyPath) settings.sshKeyPath = pendingSshPayload.keyPath;
  if (pendingSshPayload.passphrase) settings.sshKeyPassphrase = pendingSshPayload.passphrase;
  if (pendingSshPayload.jumpHost) settings.sshJumpHost = pendingSshPayload.jumpHost;
  if (pendingSshPayload.sshArgs) settings.sshArgs = pendingSshPayload.sshArgs;
  return settings;
}

// Detect private / LAN IPs that need a tunnel
function isPrivateIp(ip) {
  // Strip port if present
  var host = ip.replace(/:\d+$/, "");
  // IPv4 private ranges
  if (/^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  // localhost
  if (host === "localhost") return true;
  // IPv6 private
  if (/^(fc|fd)/i.test(host)) return true;
  if (host === "::1") return true;
  return false;
}

// Back from tunnel → whichever screen led here
$("#btn-tunnel-back").addEventListener("click", function () {
  showScreen(tunnelReturnScreen);
});

// Tunnel card selection
var tunnelCards = document.querySelectorAll(".tunnel-card");
var tunnelTokenGroup = $("#tunnel-token-group");
var tunnelTokenLabel = $("#tunnel-token-label");
var tunnelTokenInput = $("#input-tunnel-token");
var edgeLoginHint = $("#edge-login-hint");
var btnTunnelContinue = $("#btn-tunnel-continue");

tunnelCards.forEach(function (card) {
  card.addEventListener("click", function () {
    tunnelCards.forEach(function (c) { c.classList.remove("active"); });
    card.classList.add("active");
    selectedTunnel = card.dataset.tunnel;

    if (selectedTunnel === "cloudflare") {
      tunnelTokenGroup.style.display = "block";
      tunnelTokenLabel.textContent = "Cloudflare Tunnel Token";
      tunnelTokenInput.placeholder = "Paste your tunnel token";
      edgeLoginHint.style.display = "none";
      btnTunnelContinue.textContent = "Continue";
    } else if (selectedTunnel === "ngrok") {
      tunnelTokenGroup.style.display = "block";
      tunnelTokenLabel.textContent = "ngrok Auth Token";
      tunnelTokenInput.placeholder = "Paste your ngrok auth token";
      edgeLoginHint.style.display = "none";
      btnTunnelContinue.textContent = "Continue";
    } else {
      // Edge
      tunnelTokenGroup.style.display = "none";
      tunnelTokenInput.value = "";
      edgeLoginHint.style.display = "flex";
      btnTunnelContinue.textContent = "Sign In \u0026 Continue";
    }
  });
});

// Continue from tunnel → build preferences (for remote) or complete (for this machine)
$("#btn-tunnel-continue").addEventListener("click", async function () {
  if (!window.desktop) return;

  // Validate token if needed
  if ((selectedTunnel === "cloudflare" || selectedTunnel === "ngrok") && !tunnelTokenInput.value.trim()) {
    return; // Don't proceed without a token
  }

  // Store tunnel config
  var tunnelConfig = { provider: selectedTunnel };
  if (selectedTunnel !== "edge") {
    tunnelConfig.token = tunnelTokenInput.value.trim();
  }
  await window.desktop.config.set("tunnel", tunnelConfig);

  // Edge tunnel → same as other tunnels, just complete onboarding
  if (selectedTunnel === "edge") {
    showScreen("loading");
    els.loadingTitle.textContent = "Saving configuration\u2026";
    els.loadingMessage.textContent = "Almost there";

    var edgeResult = await window.desktop.onboarding.complete(
      pendingApiUrl,
      pendingDashboardUrl,
      pendingSshPayload ? buildSshSettings() : null,
      selectedBuildMode,
    );
    return;
  }

  // "This Machine" → skip build prefs (forced local), complete directly
  if (!pendingSshPayload) {
    showScreen("loading");
    els.loadingTitle.textContent = "Saving configuration\u2026";
    els.loadingMessage.textContent = "Almost there";

    var localResult = await window.desktop.onboarding.complete(
      pendingApiUrl,
      pendingDashboardUrl,
      null,
      selectedBuildMode
    );
  } else {
    // "Another Server" (LAN) → go to build preferences
    prefReturnScreen = "tunnel";
    showScreen("preferences");
  }
});

// ─── Preferences screen ──────────────────────────────────────────────────────

// Back button — return to whichever screen led here
$("#btn-pref-back").addEventListener("click", function () {
  showScreen(prefReturnScreen);
});

var prefCards = document.querySelectorAll(".pref-card");

prefCards.forEach(function (card) {
  card.addEventListener("click", function () {
    prefCards.forEach(function (c) { c.classList.remove("active"); });
    card.classList.add("active");
    selectedBuildMode = card.dataset.mode;
  });
});

// Continue — finalize onboarding with selected build mode
$("#btn-pref-continue").addEventListener("click", async function () {
  if (!window.desktop) return;

  showScreen("loading");
  els.loadingTitle.textContent = "Saving configuration\u2026";
  els.loadingMessage.textContent = "Almost there";

  // Complete onboarding — pushes all settings (SSH, tunnel, build mode) to API
  var prefResult = await window.desktop.onboarding.complete(
    pendingApiUrl,
    pendingDashboardUrl,
    buildSshSettings(),
    selectedBuildMode
  );
});
