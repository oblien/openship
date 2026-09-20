/**
 * The in-app "update available" window: a small frameless BrowserWindow with
 * its own HTML (notify → progress bar → done). Self-contained — it talks to
 * the main process through the SAME preload bridge (`window.desktop.updates`),
 * so no dashboard/web changes are needed.
 */

import { BrowserWindow, nativeTheme } from "electron";
import { changelogUrl } from "@repo/core";
import { join } from "node:path";
import type { UpdateInfo } from "./updater";

function buildHtml(info: UpdateInfo): string {
  // Values are injected as a JSON blob and written via textContent, so release
  // notes can't inject markup — but only once `<` is escaped. JSON.stringify does
  // not escape it, and the HTML parser ends an inline <script> at the first
  // `</script` regardless of JS string context, so unescaped notes containing
  // `</script>` would break out into markup in a window that carries the full
  // preload bridge.
  const title = info.announcement?.title || "Update available";
  const payload = JSON.stringify({
    version: info.version,
    title,
    announcement: (info.announcement?.message || "").trim(),
    notes:
      (info.notes || "").trim() ||
      "Release details are available in the full changelog.",
    changelogUrl: changelogUrl(`v${info.version}`),
  }).replace(/</g, "\\u003c");
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
    .wrap{display:flex;flex-direction:column;height:100vh;min-height:0;padding:24px 24px 20px;box-sizing:border-box}
    h1{font-size:16px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
    .sub{font-size:13px;color:var(--muted);margin:0 0 16px}
    .announcement{font-size:13px;line-height:1.5;color:var(--body);margin:0 0 14px;padding:11px 12px;
      border-radius:10px;background:var(--surface);border:1px solid var(--border-subtle)}
    .announcement:empty{display:none}
    .notes-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;
      color:var(--muted);margin:0 0 7px}
    pre{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;white-space:pre-wrap;word-break:break-word;
      font-family:system-ui,-apple-system,sans-serif;font-size:12.5px;
      line-height:1.58;color:var(--body);margin:0;padding:13px 14px;border-radius:12px;
      background:var(--surface);border:1px solid var(--border-subtle)}
    .status{display:none;font-size:12px;color:var(--muted);margin:14px 0 0}
    .row{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-top:14px}
    .buttons{display:flex;gap:10px;margin-inline-start:auto}
    button{border-radius:10px;padding:8px 16px;font-size:13px;font-weight:500;font-family:inherit;
      cursor:pointer;border:1px solid transparent;transition:background .15s,border-color .15s,opacity .15s}
    .changelog{padding-inline:2px;background:transparent;color:var(--body)}
    .changelog:hover{color:var(--text)}
    .later{background:transparent;color:var(--text);border-color:var(--border)}
    .later:hover{background:var(--ghost-hover)}
    .go{background:var(--btn-bg);color:var(--btn-text)}
    .go:hover{opacity:.9}
    button:disabled{opacity:.5;cursor:default}
  </style></head><body><div class="wrap">
    <h1 id="title"></h1>
    <p class="sub" id="sub"></p>
    <p class="announcement" id="announcement"></p>
    <p class="notes-label">What&rsquo;s new</p>
    <pre id="notes"></pre>
    <p class="status" id="status">Downloading…</p>
    <div class="row" id="actions">
      <button class="changelog" id="changelog">View full changelog</button>
      <div class="buttons">
        <button class="later" id="later">Later</button>
        <button class="go" id="go">Update now</button>
      </div>
    </div>
  </div><script>
    const INFO = ${payload};
    const u = window.desktop && window.desktop.updates;
    document.getElementById("title").textContent = INFO.title;
    document.getElementById("sub").textContent =
      "Openship " + INFO.version + " is ready to install.";
    document.getElementById("announcement").textContent = INFO.announcement;
    document.getElementById("notes").textContent = INFO.notes;
    const status = document.getElementById("status");
    const actions = document.getElementById("actions");
    document.getElementById("changelog").onclick = () =>
      window.desktop && window.desktop.onboarding &&
      window.desktop.onboarding.openExternal(INFO.changelogUrl);
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
    width: 560,
    height: 520,
    minWidth: 460,
    minHeight: 380,
    resizable: true,
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
      // Off for the same reason as the main window (see index.ts) — the preload
      // requires @repo/onboarding, which a sandboxed preload can't resolve.
      sandbox: false,
    },
  });
  updateWin.once("ready-to-show", () => updateWin?.show());
  updateWin.on("closed", () => {
    updateWin = null;
  });

  // This window renders one self-contained document. Its changelog action goes
  // through the scheme-gated external-browser IPC; any in-window navigation is
  // therefore something going wrong. Refuse it rather than letting an
  // off-origin page inherit the preload bridge.
  const denyNav = (e: Electron.Event, url: string) => {
    e.preventDefault();
    console.warn(`[security] blocked update-window navigation to ${url}`);
  };
  updateWin.webContents.on("will-navigate", denyNav);
  updateWin.webContents.on("will-redirect", denyNav);
  updateWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
