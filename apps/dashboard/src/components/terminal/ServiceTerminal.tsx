"use client";

/**
 * Interactive terminal surface for a single deployed service.
 *
 *   xterm.js (with stdin enabled)  ↔  usePtyConnection (WebSocket)
 *     ↔  /api/services/terminal/ws/:serviceId  ↔  Docker exec  OR  Oblien shell
 *
 * Sibling of <ServerTerminal>. The xterm + status banner + resize +
 * keystroke layers are functionally identical; the only thing that
 * varies is which transport the hook uses (server vs service ticket
 * endpoint and WS URL). Selection happens via `target: {kind, id}` on
 * usePtyConnection.
 *
 * NOTE: this file deliberately mirrors ServerTerminal.tsx rather than
 * extracting a shared base — keeping the working server terminal
 * untouched. Dedupe is a clean follow-up: extract <XtermSurface> taking
 * the PtyConnection object as a prop, then both wrappers shrink to ~50
 * lines. Doing it now would touch the working server terminal, so we
 * accept the duplication for one cycle.
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
import { RotateCw } from "lucide-react";
import { usePtyConnection } from "@/hooks/usePtyConnection";
import type { TerminalErrorCode } from "@/lib/api";
import "@xterm/xterm/css/xterm.css";

export interface ServiceTerminalHandle {
  /** Permanently close the shell + finalize the audit row (no parking). */
  terminate: () => void;
}

type TerminalTheme = "light" | "dark";

interface ServiceTerminalProps {
  serviceId: string;
  enabled: boolean;
  visible?: boolean;
  resumeToken?: string | null;
  onResumeTokenChange?: (token: string | null) => void;
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

/** Error code → human label, service-flavored. The set of codes is
 *  the union of server-terminal codes + the service-specific ones
 *  emitted by the service-terminal controller. */
function humanizeError(code: TerminalErrorCode | string): string {
  switch (code) {
    case "ssh_auth":
      return "Authentication failed for this service terminal.";
    case "ssh_connect":
      return "Could not open a shell into the service. The container may have just restarted.";
    case "server_not_found":
      return "Service not found or you don't have access to it.";
    case "not_deployed":
      return "This service has not been deployed yet. Deploy it to open a terminal.";
    case "not_supported":
      return "Terminals aren't available for the runtime this service is deployed on.";
    case "max_sessions":
      return "Too many active terminal sessions. Close one and try again.";
    case "idle_timeout":
      return "Session ended due to inactivity.";
    case "session_cap":
      return "Session reached the maximum allowed duration.";
    case "server_error":
      return "Internal server error. Please try again.";
    case "max_reconnects":
      return "Couldn't reconnect after several attempts.";
    case "transport":
      return "Connection lost.";
    default:
      return code;
  }
}

export const ServiceTerminal = forwardRef<
  ServiceTerminalHandle,
  ServiceTerminalProps
>(function ServiceTerminal(
  {
    serviceId,
    enabled,
    visible = true,
    resumeToken: resumeTokenProp = null,
    onResumeTokenChange,
    theme = "dark",
    className = "",
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  // Bytes that arrive before xterm's dynamic import finishes are buffered here
  // and flushed on mount — so the ticket/WS/shell handshake runs in PARALLEL
  // with the (sometimes slow) xterm import instead of waiting behind it.
  const pendingBytesRef = useRef<Uint8Array[]>([]);
  const [exitInfo, setExitInfo] = useState<{
    code: number | null;
    signal?: string;
  } | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  const onResumeTokenChangeRef = useRef(onResumeTokenChange);
  onResumeTokenChangeRef.current = onResumeTokenChange;

  const onBytes = useCallback((chunk: Uint8Array) => {
    const xterm = xtermRef.current;
    if (xterm) xterm.write(chunk);
    else pendingBytesRef.current.push(chunk);
  }, []);

  const onReady = useCallback(
    (info: { sessionId: string; resumeToken: string; resumed: boolean }) => {
      setExitInfo(null);
      onResumeTokenChangeRef.current?.(info.resumeToken);
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
    onResumeTokenChangeRef.current?.(null);
  }, []);

  const onError = useCallback((code: TerminalErrorCode, _msg: string) => {
    if (code === "resume_failed") {
      onResumeTokenChangeRef.current?.(null);
    }
  }, []);

  const pty = usePtyConnection({
    target: { kind: "service", id: serviceId },
    enabled: enabled && reconnectKey >= 0,
    onBytes,
    onReady,
    onExit,
    onError,
    resumeToken: resumeTokenProp,
  });

  useImperativeHandle(
    ref,
    () => ({
      terminate: () => {
        pty.terminate();
        onResumeTokenChangeRef.current?.(null);
      },
    }),
    [pty],
  );

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
        fontFamily:
          '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.15,
        theme: themeFor(theme),
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(containerRef.current);

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Flush bytes that landed while the import was in flight.
      if (pendingBytesRef.current.length) {
        for (const c of pendingBytesRef.current) terminal.write(c);
        pendingBytesRef.current = [];
      }

      terminal.onData((data: string) => {
        ptyRef.current.sendInput(data);
      });

      let selectionTimer: ReturnType<typeof setTimeout> | null = null;
      terminal.onSelectionChange(() => {
        if (selectionTimer) clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
          const sel = terminal.getSelection();
          if (!sel) return;
          try {
            void navigator.clipboard?.writeText?.(sel);
          } catch {
            /* no perms */
          }
        }, 150);
      });

      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const fit = () => {
        if (!visibleRef.current) return;
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        try {
          fitAddon.fit();
        } catch {
          /* container not yet sized */
        }
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const cols = terminal.cols;
          const rows = terminal.rows;
          if (cols && rows) ptyRef.current.sendResize(cols, rows);
        }, 100);
      };
      window.setTimeout(fit, 50);
      const ro = new ResizeObserver(fit);
      ro.observe(containerRef.current);
      window.addEventListener("resize", fit);

      cleanup = () => {
        ro.disconnect();
        window.removeEventListener("resize", fit);
        if (resizeTimer) clearTimeout(resizeTimer);
        if (selectionTimer) clearTimeout(selectionTimer);
        try {
          terminal.dispose();
        } catch {
          /* already disposed */
        }
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

  const ptyRef = useRef(pty);
  ptyRef.current = pty;

  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!visible) return;
    const xterm = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!xterm || !fitAddon) return;
    const t = window.setTimeout(() => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        /* not sized yet */
      }
      if (xterm.cols && xterm.rows) {
        ptyRef.current.sendResize(xterm.cols, xterm.rows);
      }
      try {
        xterm.focus();
      } catch {
        /* not focusable */
      }
    }, 30);
    return () => window.clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (xterm) xterm.options.theme = themeFor(theme);
  }, [theme]);

  const banner = useMemo(() => {
    if (exitInfo) {
      const exitCode = exitInfo.code ?? "?";
      return {
        tone: "neutral" as const,
        message: exitInfo.signal
          ? `Session ended (signal ${exitInfo.signal}).`
          : `Session ended (exit code ${exitCode}).`,
        showReconnect: true,
      };
    }
    if (pty.lastError) {
      return {
        tone: "error" as const,
        message: humanizeError(pty.lastError),
        showReconnect:
          pty.lastError !== "max_sessions" &&
          pty.lastError !== "server_not_found" &&
          pty.lastError !== "not_deployed" &&
          pty.lastError !== "not_supported",
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
    <div className={`relative flex h-full w-full flex-col gap-2 ${className}`}>
      {/* Status as a plain subheader line under the tab's "Terminal" header —
          no boxed banner, no border. Only shown while connecting / errored /
          exited; once connected it disappears and just the terminal remains. */}
      {banner && (
        <div className="flex items-center justify-between gap-3">
          <span
            className={
              "text-xs " +
              (banner.tone === "error" ? "text-danger" : "text-muted-foreground")
            }
          >
            {banner.message}
          </span>
          {banner.showReconnect && (
            <button
              type="button"
              onClick={handleReconnect}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <RotateCw className="size-3" />
              Reconnect
            </button>
          )}
        </div>
      )}

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden rounded-lg"
        style={{ fontSmooth: "antialiased", WebkitFontSmoothing: "antialiased" }}
      />
    </div>
  );
});

export default ServiceTerminal;
