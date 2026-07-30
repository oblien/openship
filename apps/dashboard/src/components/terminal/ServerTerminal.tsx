"use client";

/**
 * Interactive terminal surface for a single server.
 *
 *   xterm.js (with stdin enabled)  ←→  usePtyConnection (WebSocket)  ←→  /api/terminal/ws/:serverId  ←→  ssh2 PTY shell
 *
 * Side-by-side with the existing read-only TerminalSurface (which has
 * disableStdin:true and no keystroke path back to the server). We do
 * NOT extend that one — the contracts diverge too much.
 *
 * What this component owns:
 *   - The xterm Terminal lifecycle (create on mount, dispose on unmount).
 *   - FitAddon + a debounced ResizeObserver → server resize control frame.
 *   - Wiring xterm.onData → pty.sendInput and pty bytes → xterm.write.
 *   - A small status banner overlay (connecting / reconnecting / exited / error).
 *
 * What the hook owns:
 *   - The WebSocket lifecycle, reconnect logic, ticket request.
 *   - Translation between binary frames and JSON control frames.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { RotateCw, Terminal as TerminalIcon } from "lucide-react";
import { usePtyConnection } from "@/hooks/usePtyConnection";
import type { TerminalErrorCode } from "@/lib/api";
import "@xterm/xterm/css/xterm.css";

export interface ServerTerminalHandle {
  /**
   * Permanently close the shell — sends the close frame to the server
   * so it does a full teardown (no parking) and finalizes the audit
   * row. Use when the user explicitly closes a tab; for navigation /
   * unmount, let the default WS close behavior park instead.
   */
  terminate: () => void;
}

type TerminalTheme = "light" | "dark";

interface ServerTerminalProps {
  serverId: string;
  /** When false, the WS is closed and the terminal is paused. Drives
   *  the gating from the parent tab (only open while the tab is visible). */
  enabled: boolean;
  /** When false, the terminal is rendered but hidden from the user (e.g.
   *  an inactive shell tab). We skip fit-on-resize for hidden terminals
   *  (the container has zero dims while display:none) and re-fit + focus
   *  when this flips back to true. The WS stays open across hidden state
   *  so output keeps flowing into scrollback. */
  visible?: boolean;
  /**
   * Optional resume token (typically from localStorage) presented on
   * WS open to reattach to a parked session. On `resume_failed` the
   * hook fires onError; we then drop the token via onResumeTokenChange
   * and the next reconnect goes through the fresh-shell path.
   */
  resumeToken?: string | null;
  /**
   * Notifies the parent whenever the server hands us a fresh resume
   * token (every `ready` frame) so it can persist {serverId+shellId → token}.
   * Also fires with `null` when a resume fails so the parent can drop
   * the stale token from its store before the hook reconnects.
   */
  onResumeTokenChange?: (token: string | null) => void;
  /** Optional theme override; defaults to dark. */
  theme?: TerminalTheme;
  className?: string;
}

const darkTheme = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#ffffff",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#3a3a3a",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const lightTheme = {
  background: "#ffffff",
  foreground: "#1a1a1a",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "#d1d5da",
  black: "#1a1a1a",
  red: "#d73a49",
  green: "#22863a",
  yellow: "#b08800",
  blue: "#0366d6",
  magenta: "#6f42c1",
  cyan: "#1b7c83",
  white: "#6a737d",
  brightBlack: "#959da5",
  brightRed: "#cb2431",
  brightGreen: "#22863a",
  brightYellow: "#dbab09",
  brightBlue: "#0366d6",
  brightMagenta: "#6f42c1",
  brightCyan: "#1b7c83",
  brightWhite: "#1a1a1a",
};

function themeFor(mode: TerminalTheme) {
  return mode === "light" ? lightTheme : darkTheme;
}

function humanizeError(code: TerminalErrorCode | string): string {
  switch (code) {
    case "ssh_auth": return "SSH authentication failed. Check the server's stored credentials.";
    case "ssh_connect": return "Could not reach the server over SSH.";
    case "server_not_found": return "Server not found.";
    case "max_sessions": return "Too many active terminal sessions. Close one and try again.";
    case "idle_timeout": return "Session ended due to inactivity.";
    case "session_cap": return "Session reached the maximum allowed duration.";
    case "server_error": return "Internal server error. Please try again.";
    case "max_reconnects": return "Couldn't reconnect after several attempts.";
    case "transport": return "Connection lost.";
    default: return code;
  }
}

export const ServerTerminal = forwardRef<ServerTerminalHandle, ServerTerminalProps>(function ServerTerminal({
  serverId,
  enabled,
  visible = true,
  resumeToken: resumeTokenProp = null,
  onResumeTokenChange,
  theme = "dark",
  className = "",
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The xterm Terminal handle and FitAddon - held in refs because the
  // lazy import resolves async after the initial render.
  const xtermRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  // Set true once the xterm DOM is mounted; gates the hook so we don't
  // start fetching tickets before the surface is ready to render bytes.
  const [terminalReady, setTerminalReady] = useState(false);
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal?: string } | null>(null);
  // Bumped to force a fresh hook lifecycle when the user clicks Reconnect.
  const [reconnectKey, setReconnectKey] = useState(0);

  // Ref-stashed parent callback so onReady/onError closures (with
  // empty deps) always see the latest function without recreating.
  const onResumeTokenChangeRef = useRef(onResumeTokenChange);
  onResumeTokenChangeRef.current = onResumeTokenChange;

  // ── Hook: WS + reconnect ────────────────────────────────────────────────
  const onBytes = useCallback((chunk: Uint8Array) => {
    xtermRef.current?.write(chunk);
  }, []);

  const onReady = useCallback(
    (info: { sessionId: string; resumeToken: string; resumed: boolean }) => {
      setExitInfo(null);
      // Surface the fresh resume token to the parent for persistence.
      onResumeTokenChangeRef.current?.(info.resumeToken);
      // Push current dimensions on a fresh open. On RESUME, the server's
      // PTY already has the dims from the previous session — we still
      // re-send to handle window-resized-while-disconnected cases.
      const xterm = xtermRef.current;
      if (xterm) {
        setTimeout(() => {
          if (xterm.cols && xterm.rows) {
            pty.sendResize(xterm.cols, xterm.rows);
          }
        }, 0);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onExit = useCallback((code: number | null, signal?: string) => {
    setExitInfo({ code, signal });
    // A clean shell exit invalidates any stored resume token.
    onResumeTokenChangeRef.current?.(null);
  }, []);

  const onError = useCallback((code: TerminalErrorCode, _msg: string) => {
    // resume_failed → drop the stale token so the next reconnect goes
    // through the fresh-shell path. The hook does NOT treat this as
    // terminal — it'll reconnect normally on the next backoff tick.
    if (code === "resume_failed") {
      onResumeTokenChangeRef.current?.(null);
    }
  }, []);

  const pty = usePtyConnection({
    target: { kind: "server", id: serverId },
    enabled: enabled && terminalReady && reconnectKey >= 0,
    onBytes,
    onReady,
    onExit,
    onError,
    resumeToken: resumeTokenProp,
  });

  // Imperative handle for the parent (e.g. ServerTerminalTabs) to
  // explicitly terminate this shell when the user closes the tab. The
  // default unmount path lets the server park; terminate() opts into a
  // full teardown so the audit row finalizes and the slot frees up.
  useImperativeHandle(ref, () => ({
    terminate: () => {
      pty.terminate();
      // Drop the resume token so the parent's persistence layer
      // doesn't leave a dangling entry.
      onResumeTokenChangeRef.current?.(null);
    },
  }), [pty]);

  // ── xterm lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    const initialize = async () => {
      if (!containerRef.current || xtermRef.current) return;

      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      if (cancelled || !containerRef.current) return;

      const terminal = new Terminal({
        fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.15,
        theme: themeFor(theme),
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
        // disableStdin: false (default) — this is interactive.
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(containerRef.current);

      // Renderer: prefer the WebGL renderer — the default DOM renderer
      // repaints per cell and is markedly janky on output bursts + scroll,
      // which reads as "the terminal is slow". WebGL must load AFTER open()
      // (it needs the canvas). If WebGL is unavailable (no GPU/context) or
      // the context is later lost, we dispose it and fall back to the DOM
      // renderer — no functional difference, just slower paints.
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (!cancelled) {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            try { webgl.dispose(); } catch { /* already gone → DOM renderer */ }
          });
          terminal.loadAddon(webgl);
        }
      } catch {
        /* WebGL not available → default DOM renderer, still fully works */
      }

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Keystrokes → PTY stdin.
      terminal.onData((data: string) => {
        ptyRef.current.sendInput(data);
      });

      // Copy-on-select. xterm fires selectionChange on every drag tick
      // (50+ events/sec), so we debounce ~150ms past the last change to
      // approximate "user finished selecting". Empty selections are
      // skipped — a click-without-drag shouldn't clobber the clipboard.
      // The write is best-effort: unsecure origins / denied permission
      // throw; we swallow rather than break the keystroke loop.
      let selectionTimer: ReturnType<typeof setTimeout> | null = null;
      terminal.onSelectionChange(() => {
        if (selectionTimer) clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
          const sel = terminal.getSelection();
          if (!sel) return;
          try { void navigator.clipboard?.writeText?.(sel); } catch { /* no perms */ }
        }, 150);
      });

      // Resize → tell the server. Debounced so dragging the window
      // edge doesn't spam control frames. Skipped when the container
      // is hidden (display:none → zero dims would compute garbage).
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const fit = () => {
        if (!visibleRef.current) return;
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        try { fitAddon.fit(); } catch { /* container not yet sized */ }
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const cols = terminal.cols;
          const rows = terminal.rows;
          if (cols && rows) ptyRef.current.sendResize(cols, rows);
        }, 100);
      };
      // Initial fit (after layout) + ongoing observation.
      window.setTimeout(fit, 50);
      const ro = new ResizeObserver(fit);
      ro.observe(containerRef.current);
      window.addEventListener("resize", fit);

      setTerminalReady(true);

      cleanup = () => {
        ro.disconnect();
        window.removeEventListener("resize", fit);
        if (resizeTimer) clearTimeout(resizeTimer);
        if (selectionTimer) clearTimeout(selectionTimer);
        try { terminal.dispose(); } catch { /* already disposed */ }
        if (xtermRef.current === terminal) {
          xtermRef.current = null;
          fitAddonRef.current = null;
        }
      };
    };

    void initialize();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the latest pty methods inside a ref so the xterm onData /
  // onResize closures (set up once on mount) always see the current
  // sendInput / sendResize functions.
  const ptyRef = useRef(pty);
  ptyRef.current = pty;

  // visibleRef is read inside the long-lived xterm closure (fit, etc.)
  // to skip work when the terminal is hidden. Kept in a ref so we
  // don't have to re-create the closure when `visible` flips.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // When the terminal becomes visible (e.g. user switches tabs), re-fit
  // against the now-real container dims and grab focus so keystrokes go
  // here. When it becomes hidden, do nothing — the xterm state freezes
  // and the WS keeps streaming into scrollback.
  useEffect(() => {
    if (!visible) return;
    const xterm = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!xterm || !fitAddon) return;
    // Defer one tick so the container has dimensions after the parent
    // toggled display.
    const t = window.setTimeout(() => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try { fitAddon.fit(); } catch { /* not sized yet */ }
      if (xterm.cols && xterm.rows) {
        ptyRef.current.sendResize(xterm.cols, xterm.rows);
      }
      try { xterm.focus(); } catch { /* not focusable */ }
    }, 30);
    return () => window.clearTimeout(t);
  }, [visible]);

  // Apply theme changes after mount.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (xterm) xterm.options.theme = themeFor(theme);
  }, [theme]);

  // ── Status banner ───────────────────────────────────────────────────────
  const banner = useMemo(() => {
    if (exitInfo) {
      const exitCode = exitInfo.code ?? "?";
      return {
        tone: "neutral" as const,
        message:
          exitInfo.signal
            ? `Session ended (signal ${exitInfo.signal}).`
            : `Session ended (exit code ${exitCode}).`,
        showReconnect: true,
      };
    }
    if (pty.lastError) {
      return {
        tone: "error" as const,
        message: humanizeError(pty.lastError),
        showReconnect: pty.lastError !== "max_sessions" && pty.lastError !== "server_not_found",
      };
    }
    if (pty.reconnectAttempts > 0 && pty.isConnecting) {
      return {
        tone: "info" as const,
        message: `Reconnecting (attempt ${pty.reconnectAttempts})…`,
        showReconnect: false,
      };
    }
    if (pty.isConnecting) {
      return {
        tone: "info" as const,
        message: "Connecting…",
        showReconnect: false,
      };
    }
    return null;
  }, [pty.lastError, pty.isConnecting, pty.reconnectAttempts, exitInfo]);

  const handleReconnect = useCallback(() => {
    setExitInfo(null);
    pty.reconnect();
    setReconnectKey((k) => k + 1);
  }, [pty]);

  return (
    <div className={`relative flex h-full w-full flex-col overflow-hidden ${theme === "light" ? "bg-white" : "bg-[#0a0a0a]"} ${className}`}>
      {/* Status banner overlay */}
      {banner && (
        <div
          className={
            "flex items-center justify-between gap-3 border-b px-4 py-2 text-xs " +
            (banner.tone === "error"
              ? "border-danger-border bg-danger-bg text-danger"
              : banner.tone === "info"
                ? "border-border/60 bg-zinc-900/80 text-zinc-300"
                : "border-border/60 bg-zinc-900/80 text-zinc-400")
          }
        >
          <div className="flex items-center gap-2">
            <TerminalIcon className="size-3.5" />
            <span>{banner.message}</span>
          </div>
          {banner.showReconnect && (
            <button
              type="button"
              onClick={handleReconnect}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-background/60"
            >
              <RotateCw className="size-3" />
              Reconnect
            </button>
          )}
        </div>
      )}

      {/* xterm host - flex-1 so it fills whatever the parent gives it. */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 p-2"
        style={{ fontSmooth: "antialiased", WebkitFontSmoothing: "antialiased" }}
      />
    </div>
  );
});

export default ServerTerminal;
