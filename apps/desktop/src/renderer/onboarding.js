// Onboarding renderer — communicates with main process via window.desktop (exposed by preload).

var $ = function (sel) { return document.querySelector(sel); };

var screens = {
  choose: $("#screen-choose"),
  selfhost: $("#screen-selfhost"),
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
  linkTutorial: $("#link-tutorial"),
  appVersion: $("#app-version"),
};

var authMethod = "password";

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

// Cloud — open login in browser
els.btnCloud.addEventListener("click", async function () {
  if (window.desktop) {
    await window.desktop.onboarding.openExternal("https://app.openship.io/login");
  }
});

// Self-host → show form
els.btnSelfhost.addEventListener("click", function () {
  hideStatus();
  showScreen("selfhost");
});

// Back to choose
els.btnBack.addEventListener("click", function () {
  hideStatus();
  showScreen("choose");
});

// Tutorial link
els.linkTutorial.addEventListener("click", function (e) {
  e.preventDefault();
  if (window.desktop) {
    window.desktop.onboarding.openExternal("https://docs.openship.dev/self-hosting");
  }
});

// Connect self-hosted server
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

  showScreen("loading");
  els.loadingTitle.textContent = "Setting up your server\u2026";
  els.loadingMessage.textContent = "Connecting and installing Openship";

  try {
    var apiUrl = "https://" + ip + ":4000";
    var result = await window.desktop.onboarding.testConnection(apiUrl, authPayload);

    if (result.ok) {
      els.loadingMessage.textContent = "Connected! Launching dashboard\u2026";
      var dashboardUrl = "https://" + ip + ":3001";
      await window.desktop.onboarding.complete(apiUrl, dashboardUrl);
    } else {
      showScreen("selfhost");
      showStatus(result.message || "Could not reach the server", "error");
    }
  } catch (err) {
    showScreen("selfhost");
    showStatus("Connection failed \u2014 check your details and try again", "error");
  }
});

// Enter key triggers connect
els.inputServerIp.addEventListener("keydown", function (e) {
  if (e.key === "Enter") els.btnConnect.click();
});
els.inputServerPassword.addEventListener("keydown", function (e) {
  if (e.key === "Enter") els.btnConnect.click();
});
