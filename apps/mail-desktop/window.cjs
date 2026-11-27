const { BrowserWindow, WebContentsView, Menu, ipcMain, nativeTheme, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const localURL = (name) => pathToFileURL(path.join(__dirname, "launcher", name)).href;
const launcherURL = localURL("index.html");
const frameURL = localURL("frame.html");
const frames = new WeakMap();
const barHeight = 44;

function createMailWindow(options, profile) {
  const win = new BrowserWindow({
    ...options,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 16 } }
      : { frame: false, autoHideMenuBar: true }),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  const shell = win.webContents;
  shell.setWindowOpenHandler(() => ({ action: "deny" }));
  shell.on("will-navigate", (event) => event.preventDefault());

  // The native row owns its renderer. A mailbox gets the rest of the actual viewport,
  // including after resize or fullscreen, and never loads the desktop preload.
  const view =
    profile &&
    new WebContentsView({
      webPreferences: {
        session: profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
  const content = view?.webContents ?? shell;
  let dark = view ? nativeTheme.shouldUseDarkColors : true;
  let background = dark ? "#141414" : "#fafafa";
  const update = () => {
    if (shell.isDestroyed() || content.isDestroyed()) return;
    const history = content.navigationHistory;
    shell.send("mail:window-state", {
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      maximized: win.isMaximized(),
      dark,
      background,
    });
  };
  frames.set(win, { content, update });
  win.on("maximize", update);
  win.on("unmaximize", update);
  content.on("did-navigate", update);
  content.on("did-navigate-in-page", (_event, _url, mainFrame) => {
    if (mainFrame) update();
  });

  if (view) {
    const root = win.contentView;
    root.addChildView(view);
    const layout = () => {
      const { width, height } = root.getBounds();
      view.setBounds({ x: 0, y: barHeight, width, height: Math.max(0, height - barHeight) });
    };
    root.on("bounds-changed", layout);
    layout();
    win.on("focus", () => {
      if (!content.isDestroyed()) content.focus();
    });
    content.on("did-change-theme-color", (_event, color) => {
      const rgb = color?.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      dark = rgb
        ? 0.299 * parseInt(rgb[1], 16) +
            0.587 * parseInt(rgb[2], 16) +
            0.114 * parseInt(rgb[3], 16) <
          128
        : nativeTheme.shouldUseDarkColors;
      background = rgb ? color : dark ? "#141414" : "#fafafa";
      update();
    });
    win.on("close", (event) => {
      if (content.isDestroyed()) return;
      event.preventDefault();
      content.close({ waitForBeforeUnload: true });
    });
    content.on("will-prevent-unload", (event) => {
      if (
        dialog.showMessageBoxSync(win, {
          type: "question",
          message: "Discard unsaved changes?",
          buttons: ["Keep editing", "Discard"],
          defaultId: 0,
          cancelId: 0,
        }) === 1
      )
        event.preventDefault();
    });
    content.once("destroyed", () => {
      if (!win.isDestroyed()) win.close();
    });
    win.once("closed", () => {
      if (!content.isDestroyed()) content.close();
    });
  }
  const ready = shell.loadURL(view ? frameURL : launcherURL);
  return { win, content, ready };
}

ipcMain.on("mail:window-action", (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const frame = frames.get(win);
  if (
    !frame ||
    event.sender !== win.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    ![launcherURL, frameURL].includes(event.senderFrame?.url) ||
    frame.content.isDestroyed()
  )
    return;
  const history = frame.content.navigationHistory;
  switch (action) {
    case "state":
      frame.update();
      break;
    case "back":
      if (history.canGoBack()) history.goBack();
      break;
    case "forward":
      if (history.canGoForward()) history.goForward();
      break;
    case "menu":
      Menu.getApplicationMenu()?.popup({ window: win });
      break;
    case "minimize":
      win.minimize();
      break;
    case "maximize":
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case "close":
      win.close();
      break;
  }
});

function focusedContent() {
  return frames.get(BrowserWindow.getFocusedWindow())?.content;
}
module.exports = { createMailWindow, launcherURL, focusedContent };
