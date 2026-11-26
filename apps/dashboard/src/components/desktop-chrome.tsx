"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useState } from "react";
import { DesktopTitleBar } from "@repo/ui/desktop-titlebar";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useHelpMenuActions } from "@/components/HelpMenu";
import { useI18n } from "@/components/i18n-provider";

type NavState = { canGoBack: boolean; canGoForward: boolean };

type DesktopBridge = {
  isDesktop?: boolean;
  /** NOTE: platform lives under `app`, not at the top level of the bridge.
   *  Reading `desktop.platform` yields undefined, which makes macOS fall through
   *  to the Windows branch: it draws ─ □ ✕ AND skips the traffic-light inset, so
   *  the native lights land on top of whatever is at the start of the bar. */
  app?: { platform?: string };
  window?: {
    minimize: () => Promise<unknown>;
    toggleMaximize: () => Promise<unknown>;
    close: () => Promise<unknown>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
    back: () => Promise<unknown>;
    forward: () => Promise<unknown>;
    reload: () => Promise<unknown>;
    navState: () => Promise<NavState>;
    onNavStateChange: (cb: (s: NavState) => void) => () => void;
    toggleDevTools: () => Promise<unknown>;
  };
};

const bridge = (): DesktopBridge | undefined =>
  (window as unknown as { desktop?: DesktopBridge }).desktop;


/**
 * The desktop app's own header bar.
 *
 * A REAL row, not an overlay. It used to be an invisible fixed strip with no
 * layout height, which meant every element near the top had to be padded out of
 * its way by hand — the app looked inflated and each new top-anchored surface
 * needed another dodge rule. It now occupies its own height via a body inset.
 *
 *   macOS          [lights]   ‹  › ·································
 *   Windows/Linux  ‹  › ·························· [⋯  ─ □ ✕]
 *
 * Navigation sits at the START, right after the macOS traffic lights, the way
 * Spotify and every browser place it — chevrons rather than arrows, which reads as
 * chrome instead of a page control. It was briefly centred; left is better because
 * it's where the muscle memory is and it never competes with the window buttons.
 *
 * Reload, Help/DevTools and the GitHub/X links are NOT here. They belong in the
 * native application menu (main/menu.ts), which gets correct labels, accelerators
 * and OS localization for free. The ⋯ survives on Windows/Linux only because those
 * run `frame: false` and render no menu bar, so it is the sole clickable route to
 * them there.
 *
 * Window controls are platform-split on purpose:
 *   - macOS keeps its NATIVE traffic lights (`titleBarStyle: "hiddenInset"`), so
 *     we only reserve space. That preserves the green-button fullscreen menu and
 *     leaves the window closable by mouse even if this renderer stalls.
 *   - Windows/Linux run frameless, so we draw ─ □ ✕ ourselves.
 *
 * No-op in a browser (web / SaaS).
 */
export function DesktopChrome() {
  const { t } = useI18n();
  const helpActions = useHelpMenuActions();
  const [ready, setReady] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [nav, setNav] = useState<NavState>({ canGoBack: false, canGoForward: false });

  useEffect(() => {
    const d = bridge();
    if (!d?.isDesktop) return;
    const mac = d.app?.platform === "darwin";
    setIsMac(mac);
    setReady(true);

    const root = document.documentElement;
    root.classList.add("is-desktop");
    if (mac) root.classList.add("is-desktop-mac");

    void d.window?.isMaximized().then(setMaximized).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "dashboard/components/desktop-chrome");
    });
    void d.window?.navState().then(setNav).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "dashboard/components/desktop-chrome");
    });
    const offMax = d.window?.onMaximizedChange(setMaximized);
    const offNav = d.window?.onNavStateChange(setNav);

    return () => {
      offMax?.();
      offNav?.();
      root.classList.remove("is-desktop", "is-desktop-mac");
    };
  }, []);

  if (!ready) return null;

  const w = t.chrome.window;

  /* Reload + DevTools, then the standard help links. Rendered on Windows/Linux
   * only: frameless means no menu bar, so this is the sole clickable route to
   * what macOS gets from its View and Help menus. */
  const menuActions: MenuAction[] = [
    {
      id: "reload",
      label: w.reload,
      icon: <UiIcon name="refresh" className="size-4" />,
      onClick: () => void bridge()?.window?.reload(),
    },
    {
      id: "devtools",
      label: w.devTools,
      icon: <UiIcon name="wrench" className="size-4" />,
      onClick: () => void bridge()?.window?.toggleDevTools(),
    },
    { id: "devtools-divider", divider: true },
    ...helpActions,
  ];

  const controls = bridge()?.window;
  return (
    <DesktopTitleBar
      labels={w}
      mac={isMac}
      maximized={maximized}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => void controls?.back()}
      onForward={() => void controls?.forward()}
      onMinimize={() => void controls?.minimize()}
      onToggleMaximize={() => void controls?.toggleMaximize()}
      onClose={() => void controls?.close()}
      menu={
        <DropdownMenu
          actions={menuActions}
          align="right"
          className="app-titlebar-menu"
          trigger={<UiIcon name="more" size={17} />}
        />
      }
    />
  );
}
