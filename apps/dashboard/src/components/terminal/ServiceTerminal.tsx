"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Interactive terminal surface for a single deployed service.
 *
 *   xterm.js (with stdin enabled)  ↔  usePtyConnection (WebSocket)
 *     ↔  /api/services/terminal/ws/:serviceId  ↔  Docker exec  OR  Oblien shell
 *
 * Authentication, session ownership and retries use the same PTY transport
 * as the server terminal. A failed status check must not tear down this surface.
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
import { readTerminalTheme as themeFor, observeTerminalAppearance } from "@/lib/terminal-appearance";
import { usePtyConnection } from "@/hooks/usePtyConnection";
import { Button } from "@/components/ui/button";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ConnectionNotice } from "@/components/shared/ConnectionNotice";
import type { TerminalErrorCode } from "@/lib/api";
import { TerminalCardShell } from "@/components/terminal/TerminalCardShell";
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
  /** Refresh advisory service status after the runtime confirms a shell is open. */
  onConnected?: () => void;
  theme?: TerminalTheme;
  className?: string;
  /** Titlebar label for the shared shell (usually the service name). */
  name?: string;
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
    onConnected,
    theme = "dark",
    className = "",
    name,
  },
  ref,
) {
  const { t } = useI18n();
  const copy = t.projectDetail.services.connection;
  const terminalName = name ?? copy.terminal;
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
  const [hasConnected, setHasConnected] = useState(false);
  const [paused, setPaused] = useState(false);

  const onResumeTokenChangeRef = useRef(onResumeTokenChange);
  onResumeTokenChangeRef.current = onResumeTokenChange;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const onBytes = useCallback((chunk: Uint8Array) => {
    const xterm = xtermRef.current;
    if (xterm) xterm.write(chunk);
    else pendingBytesRef.current.push(chunk);
  }, []);

  const onReady = useCallback(
    (info: { sessionId: string; resumeToken: string; resumed: boolean }) => {
      setExitInfo(null);
      setHasConnected(true);
      setPaused(false);
      onResumeTokenChangeRef.current?.(info.resumeToken);
      onConnectedRef.current?.();
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
    enabled,
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
        setPaused(true);
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
        theme: themeFor(containerRef.current),
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
          } catch (diagnosticFailure) {
            observeCaughtError(diagnosticFailure, "dashboard/components/terminal/ServiceTerminal");
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
        } catch (diagnosticFailure) {
          observeCaughtError(diagnosticFailure, "dashboard/components/terminal/ServiceTerminal");
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
      const stopAppearance = observeTerminalAppearance(terminal, containerRef.current, fit);

      cleanup = () => {
        ro.disconnect();
        window.removeEventListener("resize", fit);
        stopAppearance();
        if (resizeTimer) clearTimeout(resizeTimer);
        if (selectionTimer) clearTimeout(selectionTimer);
        try {
          terminal.dispose();
        } catch (diagnosticFailure) {
          observeCaughtError(diagnosticFailure, "dashboard/components/terminal/ServiceTerminal");
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
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/components/terminal/ServiceTerminal");
        /* not sized yet */
      }
      if (xterm.cols && xterm.rows) {
        ptyRef.current.sendResize(xterm.cols, xterm.rows);
      }
      try {
        xterm.focus();
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/components/terminal/ServiceTerminal");
        /* not focusable */
      }
    }, 30);
    return () => window.clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (xterm) xterm.options.theme = themeFor(containerRef.current);
  }, [theme]);

  const banner = useMemo(() => {
    if (paused) {
      return { title: copy.pausedTitle, message: copy.pausedHint, pending: false, warning: false };
    }
    if (exitInfo) {
      return {
        title: copy.closedTitle,
        message: copy.closedHint,
        detail: exitInfo.signal
          ? interpolate(copy.exitSignal, { signal: exitInfo.signal })
          : exitInfo.code !== null ? interpolate(copy.exitCode, { code: String(exitInfo.code) }) : undefined,
        pending: false,
        warning: false,
      };
    }
    // Backoff is part of reconnecting, even before the next handshake starts.
    // A stale transport error must not obscure the automatic retry.
    if ((pty.isConnecting || pty.reconnectAttempts > 0) && (!pty.lastError || pty.lastError === "transport")) {
      return {
        title: pty.reconnectAttempts > 0 ? copy.reconnectingTitle : copy.connectingTitle,
        message: pty.reconnectAttempts > 0 ? copy.reconnectingHint : interpolate(copy.connectingHint, { name: terminalName }),
        pending: true,
        warning: false,
      };
    }
    if (pty.lastError) {
      const messages: Record<string, string> = {
        ssh_auth: copy.errors.auth,
        ssh_connect: copy.errors.connect,
        server_not_found: copy.errors.notFound,
        not_deployed: copy.errors.notDeployed,
        not_supported: copy.errors.notSupported,
        max_sessions: copy.errors.maxSessions,
        idle_timeout: copy.errors.idleTimeout,
        session_cap: copy.errors.sessionCap,
        server_error: copy.errors.server,
        max_reconnects: copy.errors.maxReconnects,
        transport: copy.errors.transport,
        "4401": copy.errors.auth,
        "4403": copy.errors.auth,
        "4404": copy.errors.notFound,
        "4429": copy.errors.maxSessions,
      };
      return {
        title: copy.errorTitle,
        message: messages[pty.lastError] ?? copy.errors.server,
        detail: pty.lastErrorMessage || undefined,
        pending: false,
        warning: true,
        cannotRetry: pty.lastError === "not_supported",
      };
    }
    if (enabled && !pty.isConnected)
      return { title: copy.connectingTitle, message: interpolate(copy.connectingHint, { name: terminalName }), pending: true, warning: false };
    return null;
  }, [copy, terminalName, enabled, paused, pty.lastError, pty.lastErrorMessage, pty.isConnecting, pty.isConnected, pty.reconnectAttempts, exitInfo]);

  const handleReconnect = useCallback(() => {
    setExitInfo(null);
    setPaused(false);
    pty.reconnect();
  }, [pty]);

  const notice = banner && (
    <ConnectionNotice
      title={banner.title}
      message={banner.message}
      detail={banner.detail}
      retrying={banner.pending}
      tone={banner.warning ? "warning" : "neutral"}
      actions={banner.pending ? (
        <Button type="button" variant="outline" size="sm" onClick={() => { setPaused(true); pty.disconnect(); }}>
          {copy.cancel}
        </Button>
      ) : !banner.cannotRetry ? (
        <Button type="button" size="sm" onClick={handleReconnect}>
          <UiIcon name="refresh" />
          {copy.reconnect}
        </Button>
      ) : undefined}
    />
  );

  return (
    <TerminalCardShell
      name={terminalName}
      className={className}
      status={
        pty.isConnected && !banner ? (
          <span role="status" className="inline-flex items-center gap-2 text-xs text-success">
            <span className="size-2 rounded-full border-2 border-success-solid" aria-hidden="true" />
            {copy.connected}
          </span>
        ) : banner?.pending && pty.reconnectAttempts > 0 ? (
          <span className="text-xs text-muted-foreground">{interpolate(copy.attempt, { attempt: String(pty.reconnectAttempts) })}</span>
        ) : undefined
      }
      notice={hasConnected ? notice : undefined}
    >
      <div
        ref={containerRef}
        className="h-full min-h-[320px] w-full overflow-hidden rounded-lg"
        aria-hidden={!hasConnected && !!banner}
        style={{ fontSmooth: "antialiased", WebkitFontSmoothing: "antialiased" }}
      />
      {!hasConnected && notice && (
        <div className="absolute inset-0 flex items-center justify-center bg-card p-4">
          <div className="w-full max-w-lg">{notice}</div>
        </div>
      )}
    </TerminalCardShell>
  );
});

export default ServiceTerminal;
