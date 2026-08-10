/**
 * The native application menu.
 *
 * Everything that used to be crammed into the titlebar's ⋯ button lives here
 * instead — Reload, Developer Tools, and the Help links. That is where a desktop
 * user looks for them, and Electron's built-in `role`s bring correct labels,
 * platform-appropriate accelerators and OS localization for free, which a
 * hand-rolled dropdown never gets right.
 *
 * Registered on EVERY platform, deliberately, even though only macOS renders a
 * menu bar: Windows/Linux run `frame: false`, which hides the menu bar entirely.
 * The menu still installs the real accelerators there (Ctrl+R, Ctrl+Shift+I, …),
 * so the shortcuts work even with nothing to click — and the titlebar keeps its ⋯
 * on those platforms as the visible entry point. See DesktopChrome.
 */

import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { BRAND_LINKS } from "@repo/core";

const isMac = process.platform === "darwin";

/** Help entries, shared with the dashboard's in-app menu via BRAND_LINKS. */
const helpItems: MenuItemConstructorOptions[] = [
  { label: "Documentation", click: () => void shell.openExternal(BRAND_LINKS.docs) },
  { label: "Contact Support", click: () => void shell.openExternal(BRAND_LINKS.support) },
  { label: "Report an Issue", click: () => void shell.openExternal(BRAND_LINKS.issues) },
  { label: "Send Feedback", click: () => void shell.openExternal(BRAND_LINKS.contact) },
  { type: "separator" },
  { label: "Community (Discord)", click: () => void shell.openExternal(BRAND_LINKS.community) },
  { label: "Openship on GitHub", click: () => void shell.openExternal(BRAND_LINKS.github) },
  { label: "Openship on X", click: () => void shell.openExternal(BRAND_LINKS.x) },
];

export function buildAppMenu(getWindow: () => BrowserWindow | null): void {
  const template: MenuItemConstructorOptions[] = [
    // macOS puts the app menu first; on Windows/Linux there is no equivalent, so
    // quit lives under File.
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : ([{ label: "File", submenu: [{ role: "quit" }] }] as MenuItemConstructorOptions[])),

    // Edit is not optional even in an app with no text editor: without it, the
    // OS-level Cut/Copy/Paste accelerators do not reach input fields on macOS.
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? ([{ role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }] as MenuItemConstructorOptions[])
          : ([{ role: "delete" }, { type: "separator" }, { role: "selectAll" }] as MenuItemConstructorOptions[])),
      ],
    },

    {
      label: "View",
      submenu: [
        // Reload moved here from the titlebar. `role` wires Cmd/Ctrl+R for us.
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? ([{ type: "separator" }, { role: "front" }] as MenuItemConstructorOptions[])
          : ([{ role: "close" }] as MenuItemConstructorOptions[])),
      ],
    },

    // `role: "help"` marks this as the Help menu so macOS adds its search field.
    { role: "help", submenu: helpItems },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // Keep the hidden menu bar hidden on Windows/Linux — with `frame: false` it
  // cannot render anyway, and leaving it toggleable makes Alt flash an empty strip.
  if (!isMac) getWindow()?.setMenuBarVisibility(false);
}
