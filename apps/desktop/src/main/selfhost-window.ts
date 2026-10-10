/**
 * Small prompt that asks for a self-hosted instance URL.
 *
 * The prompt is a local data: page. Sign-in happens in the system browser.
 * This window never loads the remote origin.
 */

import { BrowserWindow } from "electron";
import { join } from "node:path";

export const DEFAULT_SELFHOST_DASHBOARD_URL = "";

let promptWindow: BrowserWindow | null = null;

export function closeSelfHostPrompt(): void {
  if (promptWindow && !promptWindow.isDestroyed()) promptWindow.close();
  promptWindow = null;
}

export function openSelfHostPrompt(initialUrl: string): void {
  const url = initialUrl.trim() || DEFAULT_SELFHOST_DASHBOARD_URL;
  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow.show();
    promptWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 480,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Connect self-hosted instance",
    center: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: "#f4f4f5",
    webPreferences: {
      preload: join(__dirname, "../selfhost-prompt/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  promptWindow = win;

  const deny = (event: Electron.Event) => {
    event.preventDefault();
  };
  win.webContents.on("will-navigate", deny);
  win.webContents.on("will-redirect", deny);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
    win.setAlwaysOnTop(false);
  });
  win.on("closed", () => {
    if (promptWindow === win) promptWindow = null;
  });

  const html = buildSelfHostConnectPage({ initialUrl: url, mode: "prompt" });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

export function buildSelfHostConnectPage(options: {
  initialUrl: string;
  mode: "launcher" | "prompt";
  notice?: string;
}): string {
  const value = escapeHtml(options.initialUrl);
  const notice = options.notice?.trim()
    ? `<p class="notice">${escapeHtml(options.notice.trim())}</p>`
    : "";
  const secondaryLabel = options.mode === "prompt" ? "Cancel" : "Use local instance";
  const bridge = options.mode === "prompt" ? "window.selfhostPrompt" : "window.desktop.selfHost";
  const onSecondary =
    options.mode === "prompt"
      ? `await bridge.cancel();`
      : `await bridge.disconnect(); message.textContent = "Closed. This window stays on the local instance.";`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect self-hosted instance</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; background: #f4f4f5; color: #18181b; }
  .card { width: min(440px, calc(100vw - 48px)); background: #fff; color: #18181b; border: 1px solid #e4e4e7; border-radius: 16px; padding: 28px 28px 22px; box-sizing: border-box; }
  h1 { font-size: 22px; line-height: 1.3; margin: 0 0 8px; color: inherit; }
  p { margin: 0; }
  p.lead { margin: 0 0 16px; color: #52525b; }
  p.notice { margin: 0 0 14px; color: #b45309; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: inherit; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid #d4d4d8; background: #fff; color: #18181b; }
  .row { display: flex; gap: 8px; margin-top: 14px; }
  button { font: inherit; border-radius: 10px; padding: 10px 14px; border: 0; cursor: pointer; }
  button.primary { background: #18181b; color: #fff; }
  button.secondary { background: transparent; color: #18181b; border: 1px solid #d4d4d8; }
  #selfhost-message { min-height: 1.2em; margin-top: 12px; font-size: 13px; }
  .foot { margin-top: 14px; font-size: 12px; color: #71717a; }
  @media (prefers-color-scheme: dark) {
    body { background: #141414; }
    .card { background: #1c1c1c; color: #f4f4f5; border-color: #333; }
    p.lead, .foot { color: #a1a1aa; }
    input { background: #111; color: #f4f4f5; border-color: #3f3f46; }
    button.primary { background: #f4f4f5; color: #18181b; }
    button.secondary { color: #e4e4e7; border-color: #3f3f46; }
  }
</style>
</head>
<body>
  <form class="card" id="selfhost-form" novalidate>
    <h1>Connect self-hosted instance</h1>
    <p class="lead">Connect opens the system browser. Sign in there.</p>
    ${notice}
    <label for="selfhost-url">Instance URL</label>
    <input id="selfhost-url" name="url" type="url" spellcheck="false" autocomplete="off" placeholder="https://ops.example.com" value="${value}">
    <div class="row">
      <button class="primary" id="selfhost-connect" type="submit">Connect</button>
      <button class="secondary" id="selfhost-secondary" type="button">${secondaryLabel}</button>
    </div>
    <p id="selfhost-message" role="status"></p>
    <p class="foot">Sign-in uses the same browser handoff as Openship Cloud. This window does not load the site.</p>
  </form>
  <script>
    const bridge = ${bridge};
    const message = document.getElementById("selfhost-message");
    const input = document.getElementById("selfhost-url");
    document.getElementById("selfhost-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!bridge || !bridge.connect) {
        message.textContent = "This window cannot reach the app.";
        return;
      }
      message.textContent = "Opening the browser…";
      try {
        const result = await bridge.connect(input.value);
        message.textContent = result && result.ok ? "Browser opened. Come back here after you sign in." : ((result && result.error) || "Connection failed");
      } catch (err) {
        message.textContent = "Connection failed";
      }
    });
    document.getElementById("selfhost-secondary").addEventListener("click", async () => {
      if (!bridge) return;
      try { ${onSecondary} } catch (err) { message.textContent = "That action failed."; }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
