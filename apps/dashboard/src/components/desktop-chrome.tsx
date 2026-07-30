"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, RefreshCw, Wrench } from "lucide-react";
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

    void d.window?.isMaximized().then(setMaximized).catch(() => {});
    void d.window?.navState().then(setNav).catch(() => {});
    const offMax = d.window?.onMaximizedChange(setMaximized);
    const offNav = d.window?.onNavStateChange(setNav);

    return () => {
      offMax?.();
      offNav?.();
      root.classList.remove("is-desktop", "is-desktop-mac");
    };
  }, []);

  /* macOS zooms the window on a double-click anywhere in a drag region, so an
   * accidental double-click near the top used to throw the app fullscreen. Own
   * the gesture instead of letting the OS have it: one deliberate toggle. */
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    void bridge()?.window?.toggleMaximize();
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
      icon: <RefreshCw className="size-4" />,
      onClick: () => void bridge()?.window?.reload(),
    },
    {
      id: "devtools",
      label: w.devTools,
      icon: <Wrench className="size-4" />,
      onClick: () => void bridge()?.window?.toggleDevTools(),
    },
    { id: "devtools-divider", divider: true },
    ...helpActions,
  ];

  return (
    <header className="app-titlebar" onDoubleClick={onDoubleClick}>
      {/* Start — navigation, after the macOS traffic-light inset. No brand: the
          sidebar header renders the mark + "Openship" directly below, and having
          both read as the same logo twice within ~40px. */}
      <nav className="app-titlebar-nav" aria-label={w.navigation}>
        <button
          type="button"
          className="app-titlebar-btn"
          onClick={() => void bridge()?.window?.back()}
          disabled={!nav.canGoBack}
          aria-label={w.back}
          title={w.back}
        >
          <ChevronLeft className="size-[21px]" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="app-titlebar-btn"
          onClick={() => void bridge()?.window?.forward()}
          disabled={!nav.canGoForward}
          aria-label={w.forward}
          title={w.forward}
        >
          <ChevronRight className="size-[21px]" strokeWidth={1.5} />
        </button>
      </nav>

      {/* Middle — pure drag surface. */}
      <div className="app-titlebar-drag" />

      {/* End — Windows/Linux only. macOS leaves this empty: its native menu holds
          Reload / DevTools / Help (including the GitHub and X links), and the
          traffic lights are the window controls. */}
      <div className="app-titlebar-end">

        {/* Windows/Linux only. Those run `frame: false`, so no menu bar renders
            and this is the only way to reach Reload / DevTools / Help. macOS has
            the real application menu (see main/menu.ts) and needs no duplicate. */}
        {!isMac && (
          <DropdownMenu
            actions={menuActions}
            align="right"
            className="app-titlebar-menu"
            trigger={<MoreHorizontal className="size-[17px]" strokeWidth={1.7} />}
          />
        )}

        {!isMac && (
          <div className="app-titlebar-controls">
            <button
              type="button"
              className="app-titlebar-btn"
              onClick={() => void bridge()?.window?.minimize()}
              aria-label={w.minimize}
              title={w.minimize}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true" className="app-titlebar-wc">
                <path d="M2 6h8" />
              </svg>
            </button>
            <button
              type="button"
              className="app-titlebar-btn"
              onClick={() => void bridge()?.window?.toggleMaximize()}
              aria-label={maximized ? w.restore : w.maximize}
              title={maximized ? w.restore : w.maximize}
            >
              {maximized ? (
                /* Overlapping squares = restore down, the standard Windows glyph. */
                <svg viewBox="0 0 12 12" aria-hidden="true" className="app-titlebar-wc">
                  <path d="M3.5 3.5V2.5h6v6h-1" />
                  <rect x="2.5" y="4.5" width="5" height="5" />
                </svg>
              ) : (
                <svg viewBox="0 0 12 12" aria-hidden="true" className="app-titlebar-wc">
                  <rect x="2.5" y="2.5" width="7" height="7" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="app-titlebar-btn app-titlebar-btn--close"
              onClick={() => void bridge()?.window?.close()}
              aria-label={w.close}
              title={w.close}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true" className="app-titlebar-wc">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
