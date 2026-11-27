const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require("electron");
const { readFileSync, writeFileSync, renameSync, mkdirSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { createMailWindow, launcherURL, focusedContent } = require("./window.cjs");
const { mailboxAddress, webOrigin, resolveConnection } = require("./connections.cjs");

app.setName("OpenShip Mail");
app.enableSandbox();
const development = !app.isPackaged;
if (development) {
  const directory = process.env.OPENSHIP_MAIL_USER_DATA_DIR || app.getPath("userData") + " Dev";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath("userData", path.resolve(directory));
}
const cloud = webOrigin(
  (development && process.env.OPENSHIP_CLOUD_API_URL) || "https://api.openship.io",
  development,
);
const accountFile = path.join(app.getPath("userData"), "mailboxes.json");
const windows = new Map();
let accounts = [];
let launcher;
let opening = false;
let firstLaunchView = true;
let quitting = false;

function loadAccounts() {
  try {
    const saved = JSON.parse(readFileSync(accountFile, "utf8"));
    if (!Array.isArray(saved)) throw new Error("Invalid mailbox list");
    accounts = saved.map(({ id, mode, email, origin }) => {
      if (!/^[a-f0-9-]{36}$/.test(id) || !["cloud", "self"].includes(mode))
        throw new Error("Invalid mailbox");
      return { id, mode, email: mailboxAddress(email), origin: webOrigin(origin, development) };
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function saveAccounts(next) {
  writeFileSync(accountFile + ".tmp", JSON.stringify(next), { mode: 0o600 });
  renameSync(accountFile + ".tmp", accountFile);
  accounts = next;
}

function showAccounts() {
  if (launcher && !launcher.isDestroyed()) {
    launcher.show();
    launcher.focus();
    return;
  }
  const { win, ready } = createMailWindow({
    title: "OpenShip Mail",
    width: 640,
    height: 690,
    minWidth: 420,
    minHeight: 500,
    backgroundColor: "#141414",
  });
  launcher = win;
  launcher.on("closed", () => {
    launcher = undefined;
  });
  void ready;
}

function accountSession(id) {
  return session.fromPartition("persist:mail-" + id);
}

async function externalLink(win, target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    win.isDestroyed()
  )
    return;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    message: "Open this link in your browser?",
    detail: url.href,
    buttons: ["Cancel", "Open link"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await shell.openExternal(url.href);
}

async function openMailbox(account, firstVisit) {
  const existing = windows.get(account.id);
  if (existing) {
    existing.show();
    existing.focus();
    launcher?.hide();
    return;
  }
  const profile = accountSession(account.id);
  profile.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  profile.setPermissionCheckHandler(() => false);
  if (firstVisit) {
    try {
      const response = await profile.fetch(account.origin + "/auth/session", {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok || (await response.json()) !== null)
        throw new Error("Invalid login endpoint");
    } catch {
      throw new Error(
        "Could not reach OpenShip Mail at " +
          account.origin +
          ". Check the webmail address and its certificate.",
      );
    }
  }
  const {
    win,
    content: wc,
    ready,
  } = createMailWindow(
    {
      title: account.email + " — OpenShip Mail",
      width: 1220,
      height: 820,
      minWidth: 450,
      minHeight: 520,
      backgroundColor: "#141414",
      show: false,
    },
    profile,
  );
  const allowed = (target) => {
    try {
      return new URL(target).origin === account.origin;
    } catch {
      return false;
    }
  };
  win.on("page-title-updated", (event) => event.preventDefault());
  wc.on("will-navigate", (event) => {
    const target = event.url;
    if (allowed(target)) return;
    event.preventDefault();
    void externalLink(win, target);
  });
  wc.on("will-redirect", (event) => {
    if (event.isMainFrame && !allowed(event.url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (["foreground-tab", "background-tab", "new-window"].includes(disposition))
      void externalLink(win, url);
    return { action: "deny" };
  });
  // Webmail reloads after signing in or switching its active mailbox.
  wc.on("did-finish-load", async () => {
    if (!wc.getURL().startsWith(account.origin + "/mail/")) return;
    try {
      const response = await profile.fetch(account.origin + "/auth/session", {
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return;
      const current = mailboxAddress((await response.json())?.email);
      if (
        win.isDestroyed() ||
        !accounts.some((row) => row.id === account.id) ||
        current === account.email
      )
        return;
      saveAccounts(
        accounts.map((row) => (row.id === account.id ? { ...row, email: current } : row)),
      );
      account.email = current;
      win.setTitle(current + " — OpenShip Mail");
    } catch {
      /* Webmail remains usable while its session endpoint is offline. */
    }
  });
  win.on("closed", () => {
    windows.delete(account.id);
    if (!quitting && !windows.size && launcher && !launcher.isVisible()) launcher.close();
  });
  const url = new URL(firstVisit ? "/login" : "/", account.origin);
  if (firstVisit) url.hash = new URLSearchParams({ email: account.email }).toString();
  try {
    await Promise.all([ready, wc.loadURL(url.href)]);
    if (!allowed(wc.getURL())) throw new Error("Unexpected destination");
  } catch {
    if (!win.isDestroyed()) win.destroy();
    throw new Error(
      "Could not open " +
        account.origin +
        ". Check that the webmail server is online and its TLS certificate is valid.",
    );
  }
  if (firstVisit) {
    try {
      saveAccounts([...accounts, account]);
    } catch {
      win.destroy();
      throw new Error("Could not save this mailbox on your device.");
    }
  }
  windows.set(account.id, win);
  win.show();
  launcher?.hide();
}

function handle(action, run) {
  ipcMain.handle("mail:" + action, async (event, input) => {
    if (
      !launcher ||
      event.sender !== launcher.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== launcherURL
    )
      throw new Error("Mailbox picker required.");
    if (action !== "list" && opening) return { error: "A mailbox operation is in progress." };
    if (action !== "list") opening = true;
    try {
      return { data: await run(input) };
    } catch (error) {
      return { error: error.message };
    } finally {
      if (action !== "list") opening = false;
    }
  });
}

function findAccount(id) {
  const account = accounts.find((item) => item.id === id);
  if (!account) throw new Error("Select a saved mailbox.");
  return account;
}
handle("list", () => {
  const resume = firstLaunchView && accounts.length === 1;
  firstLaunchView = false;
  return { accounts, resume };
});
handle("connect", async (input) => {
  const connection = await resolveConnection(input, { cloud, development });
  const existing = accounts.find(
    (item) =>
      item.mode === connection.mode &&
      item.email.toLowerCase() === connection.email.toLowerCase() &&
      (item.mode === "cloud" || item.origin === connection.origin),
  );
  if (existing && existing.origin !== connection.origin)
    throw new Error(
      "Your webmail address has changed. Remove the saved mailbox and connect again.",
    );
  const account = existing || { ...connection, id: randomUUID() };
  await openMailbox(account, !existing);
});
handle("open", async (id) => {
  const account = findAccount(id);
  if (account.mode === "cloud" && !windows.has(id)) {
    const current = await resolveConnection(account, { cloud, development });
    if (current.origin !== account.origin)
      throw new Error(
        "Your webmail address has changed. Remove the saved mailbox and connect again.",
      );
  }
  await openMailbox(account, false);
});
handle("forget", async (id) => {
  const account = findAccount(id);
  const { response } = await dialog.showMessageBox(launcher, {
    type: "question",
    message: "Remove " + account.email + " from this device?",
    detail:
      "This closes its window and clears its local session and cache. Your messages stay on the server.",
    buttons: ["Cancel", "Remove mailbox"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return;
  windows.get(id)?.destroy();
  const profile = accountSession(id);
  await profile.clearData();
  saveAccounts(accounts.filter((item) => item.id !== id));
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (app.isReady()) showAccounts();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    if (quitting || process.platform !== "darwin") app.quit();
  });
  app.whenReady().then(() => {
    try {
      loadAccounts();
    } catch {
      dialog.showErrorBox(
        "Could not read saved mailboxes",
        "Check the mailbox list in " + accountFile + " and reopen OpenShip Mail.",
      );
      return app.quit();
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        {
          label: "Mailboxes",
          submenu: [
            {
              label: "Switch or add mailbox…",
              accelerator: "CmdOrCtrl+Shift+M",
              click: showAccounts,
            },
            { type: "separator" },
            { role: "close" },
          ],
        },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            {
              label: "Reload",
              accelerator: "CmdOrCtrl+R",
              click: () => focusedContent()?.reload(),
            },
            {
              label: "Actual Size",
              accelerator: "CmdOrCtrl+0",
              click: () => focusedContent()?.setZoomLevel(0),
            },
            ...[
              ["Zoom In", "CmdOrCtrl+Plus", 1],
              ["Zoom Out", "CmdOrCtrl+-", -1],
            ].map(([label, accelerator, delta]) => ({
              label,
              accelerator,
              click: () => {
                const content = focusedContent();
                if (content) content.setZoomLevel(content.getZoomLevel() + delta);
              },
            })),
          ],
        },
        { role: "windowMenu" },
      ]),
    );
    showAccounts();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) showAccounts();
    });
  });
}
