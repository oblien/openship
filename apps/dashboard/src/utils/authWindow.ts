/**
 * Auth window opener middleware.
 *
 * Abstracts window opening for OAuth flows so the same code works in:
 * - Browser: opens a centered popup with `window.open()`, detects close via polling
 * - Electron: opens system browser via desktop bridge, detects completion on app re-focus
 *
 * Usage:
 *   const handle = openAuthWindow();        // opens immediately (user-gesture safe)
 *   const url = await fetchOAuthUrl();       // async work
 *   handle.navigate(url);                    // redirect the opened window
 *   handle.onClose(() => { ... });           // fires when auth flow ends
 */

/* ── Public types ─────────────────────────────────────────────────── */

export interface AuthWindowHandle {
  /** Redirect / open the auth URL. In browser, redirects the popup.
   *  In Electron, opens system browser. */
  navigate: (url: string) => void;
  /** Register a callback for when auth is considered complete.
   *  Browser: fires when popup closes.
   *  Electron: fires when the app window regains focus. */
  onClose: (cb: () => void) => void;
  /** Force-close / cleanup. */
  close: () => void;
}

/** Factory function signature — consumers only see this. */
export type WindowOpenerFn = (initialUrl?: string) => AuthWindowHandle;

/* ── Environment detection ────────────────────────────────────────── */

function isElectron(): boolean {
  return (
    typeof window !== "undefined" &&
    "desktop" in window &&
    !!(window as any).desktop?.isDesktop
  );
}

/* ── Browser opener ───────────────────────────────────────────────── */

const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;

function createBrowserHandle(initialUrl = "about:blank"): AuthWindowHandle {
  const left = window.screen.width / 2 - POPUP_WIDTH / 2;
  const top = window.screen.height / 2 - POPUP_HEIGHT / 2;

  const popup = window.open(
    initialUrl,
    "Auth",
    `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`
  );

  let timer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    navigate(url: string) {
      if (popup && !popup.closed) {
        popup.location.href = url;
        popup.focus();
      }
    },

    onClose(cb: () => void) {
      cleanup();
      timer = setInterval(() => {
        if (!popup || popup.closed) {
          cleanup();
          cb();
        }
      }, 500);
    },

    close() {
      cleanup();
      popup?.close();
    },
  };
}

/* ── Electron opener ──────────────────────────────────────────────── */

function createElectronHandle(_initialUrl?: string): AuthWindowHandle {
  // In Electron, `window.open()` is intercepted and denied.
  // We use the desktop bridge to open URLs in the system browser and
  // detect "completion" when the user brings focus back to the app.

  const desktop = (window as any).desktop;
  let focusHandler: (() => void) | null = null;

  function cleanup() {
    if (focusHandler) {
      window.removeEventListener("focus", focusHandler);
      focusHandler = null;
    }
  }

  return {
    navigate(url: string) {
      desktop.onboarding.openExternal(url);
    },

    onClose(cb: () => void) {
      cleanup();
      // When the Electron window regains focus, the user is back — trigger callback.
      focusHandler = () => {
        cleanup();
        cb();
      };
      window.addEventListener("focus", focusHandler);
    },

    close() {
      cleanup();
      // Cannot close an external browser window — no-op.
    },
  };
}

/* ── Default export: auto-detects environment ─────────────────────── */

/**
 * Open an auth window using the right strategy for the current runtime.
 *
 * Call this **synchronously from a user gesture** (click handler) so the
 * browser doesn't block the popup.
 */
export const openAuthWindow: WindowOpenerFn = (initialUrl?: string) => {
  if (isElectron()) {
    return createElectronHandle(initialUrl);
  }
  return createBrowserHandle(initialUrl);
};
