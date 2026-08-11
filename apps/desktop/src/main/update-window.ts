/**
 * The in-app "update available" window: a small frameless BrowserWindow with
 * its own HTML (notify → progress bar → done). Self-contained — it talks to
 * the main process through the SAME preload bridge (`window.desktop.updates`),
 * so no dashboard/web changes are needed.
 */

import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import type { UpdateInfo } from "./updater";

function buildHtml(info: UpdateInfo): string {
  // Values are injected as a JSON blob and written via textContent in the
  // script, so release-note contents can't inject markup.
  const payload = JSON.stringify({ version: info.version, notes: info.notes });
  // Colors mirror the dashboard theme tokens (apps/dashboard styles/theme.css)
  // and follow the OS light/dark setting via prefers-color-scheme, so the modal
  // reads as part of the app rather than a stock system dialog.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{
      color-scheme:light dark;
      --bg:#ffffff; --text:rgba(0,0,0,.92); --body:rgba(0,0,0,.66); --muted:rgba(0,0,0,.52);
      --surface:rgba(0,0,0,.04); --border:#e8e8e8; --border-subtle:#f0f0f0;
      --btn-bg:rgba(0,0,0,.92); --btn-text:#ffffff; --ghost-hover:rgba(0,0,0,.05);
    }
    @media (prefers-color-scheme:dark){:root{
      --bg:#000000; --text:rgba(255,255,255,.95); --body:rgba(255,255,255,.66); --muted:rgba(255,255,255,.50);
      --surface:rgba(255,255,255,.04); --border:rgba(255,255,255,.08); --border-subtle:rgba(255,255,255,.05);
      --btn-bg:#ffffff; --btn-text:#000000; --ghost-hover:rgba(255,255,255,.06);
    }}
    html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
      font-family:system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
    .wrap{display:flex;flex-direction:column;height:100vh;padding:22px 22px 18px;box-sizing:border-box}
    h1{font-size:16px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
    .sub{font-size:13px;color:var(--muted);margin:0 0 14px}
    pre{flex:1;overflow:auto;white-space:pre-wrap;word-break:break-word;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
      line-height:1.55;color:var(--body);margin:0;padding:12px;border-radius:12px;
      background:var(--surface);border:1px solid var(--border-subtle)}
    .status{display:none;font-size:12px;color:var(--muted);margin:14px 0 0}
    .row{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}
    button{border-radius:10px;padding:8px 16px;font-size:13px;font-weight:500;font-family:inherit;
      cursor:pointer;border:1px solid transparent;transition:background .15s,border-color .15s,opacity .15s}
    .later{background:transparent;color:var(--text);border-color:var(--border)}
    .later:hover{background:var(--ghost-hover)}
    .go{background:var(--btn-bg);color:var(--btn-text)}
    .go:hover{opacity:.9}
    button:disabled{opacity:.5;cursor:default}
  </style></head><body><div class="wrap">
    <h1 id="title">Update available</h1>
    <p class="sub" id="sub"></p>
    <pre id="notes"></pre>
    <p class="status" id="status">Downloading…</p>
    <div class="row" id="actions">
      <button class="later" id="later">Later</button>
      <button class="go" id="go">Update now</button>
    </div>
  </div><script>
    const INFO = ${payload};
    const u = window.desktop && window.desktop.updates;
    document.getElementById("sub").textContent =
      "Openship " + INFO.version + " is ready to install.";
    document.getElementById("notes").textContent = (INFO.notes || "").trim() ||
      "A new version is available.";
    const status = document.getElementById("status");
    const actions = document.getElementById("actions");
    document.getElementById("later").onclick = () => u && u.dismiss();
    document.getElementById("go").onclick = () => {
      actions.style.display = "none";
      status.style.display = "block";
      status.textContent = "Starting update…";
      // Progress lives in the app's top-of-page update bar from here — the main
      // process closes this modal as soon as the download begins.
      if (u) u.start();
    };
  </script></body></html>`;
}

let updateWin: BrowserWindow | null = null;

/** Open (or focus) the update window. Returns it so the caller can push progress. */
export function openUpdateWindow(
  parent: BrowserWindow | null,
  info: UpdateInfo,
): BrowserWindow {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.focus();
    return updateWin;
  }
  updateWin = new BrowserWindow({
    width: 460,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Openship Update",
    parent: parent ?? undefined,
    show: false,
    // Match the app's page background per OS theme so there's no wrong-theme
    // flash before the HTML paints (mirrors the main window in index.ts).
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  updateWin.once("ready-to-show", () => updateWin?.show());
  updateWin.on("closed", () => {
    updateWin = null;
  });
  void updateWin.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(info))}`,
  );
  return updateWin;
}

export function getUpdateWindow(): BrowserWindow | null {
  return updateWin && !updateWin.isDestroyed() ? updateWin : null;
}

export function closeUpdateWindow(): void {
  if (updateWin && !updateWin.isDestroyed()) updateWin.close();
  updateWin = null;
}
