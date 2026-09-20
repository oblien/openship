"use client";

/**
 * Duplex WebSocket transport for a live interactive PTY.
 *
 * Flow:
 *
 *   1. Request a one-shot ticket from /api/terminal/ticket.
 *   2. Open a WebSocket with `Sec-WebSocket-Protocol` = TERMINAL_SUBPROTOCOL_PREFIX + token.
 *   3. Binary frames in BOTH directions are raw PTY bytes - written via
 *      `sendInput(data)` and surfaced to `onBytes(chunk)`.
 *   4. JSON text frames are control messages - `{type:"ready"}` flips
 *      isConnected, `{type:"exit"}` and `{type:"error"}` are terminal,
 *      `{type:"pong"}` acknowledges keepalive, `resize` is
 *      client→server (sent via `sendResize`).
 *
 * Reconnect policy:
 *   - Only retry on transport-level closes (1001/1005/1006/abnormal).
 *   - Skip retry on auth failures (close code 4401), max-sessions
 *     (4429), idle/cap timeouts, server-not-found (4404), origin
 *     denied (4403), and remote_exit (clean code 1000).
 *   - Exponential backoff: 1s → 2s → 4s, max 3 attempts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildTerminalWsUrl,
  buildServiceTerminalWsUrl,
  requestTerminalTicket,
  requestServiceTerminalTicket,
  TERMINAL_RESUME_SUBPROTOCOL_PREFIX,
  TERMINAL_SUBPROTOCOL_PREFIX,
  type ServerControlMsg,
  type TerminalErrorCode,
} from "@/lib/api";

/**
 * What we're opening a shell against. The wire protocol is identical
 * for both kinds — server flavor uses the host's SSH PTY, service
 * flavor uses Docker exec or Oblien shell depending on the runtime.
 * The hook dispatches to the right ticket endpoint and WS URL based
 * on this kind.
 */
export type PtyTarget = { kind: "server"; id: string } | { kind: "service"; id: string };

function pickTransport(target: PtyTarget) {
  if (target.kind === "service") {
    return {
      requestTicket: () => requestServiceTerminalTicket(target.id),
      buildWsUrl: () => buildServiceTerminalWsUrl(target.id),
    };
  }
  return {
    requestTicket: () => requestTerminalTicket(target.id),
    buildWsUrl: () => buildTerminalWsUrl(target.id),
  };
}

const HEARTBEAT_INTERVAL_MS = 25_000;
const CONNECT_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 3;

interface UsePtyConnectionArgs {
  /** Target to open a shell against — discriminated `{kind, id}`. */
  target: PtyTarget | null;
  /** Receives every binary PTY chunk from the server. */
  onBytes: (chunk: Uint8Array) => void;
  /**
   * WS handshake completed + remote shell open. The hook surfaces the
   * server's `resumeToken` and the `resumed` flag so the caller can
   * persist the token (e.g. localStorage) across reloads.
   */
  onReady?: (info: { sessionId: string; resumeToken: string; resumed: boolean }) => void;
  /** Remote shell exited (with code/signal). Terminal — no reconnect. */
  onExit?: (code: number | null, signal?: string) => void;
  /** Server-emitted error (auth, ssh, timeout, etc.). */
  onError?: (code: TerminalErrorCode, message: string) => void;
  /** When false, the hook tears down any active socket and stops. */
  enabled: boolean;
  /**
   * Optional resume token to present in the WS subprotocol. When the
   * server validates it, we reattach to the parked session instead of
   * opening a fresh shell. When it fails, the hook fires onError with
   * code "resume_failed" so the caller can drop the stale token and
   * reconnect with no resume.
   */
  resumeToken?: string | null;
}

export interface PtyConnection {
  isConnecting: boolean;
  isConnected: boolean;
  reconnectAttempts: number;
  /** Last error code surfaced from the server (or "transport" on abnormal close). */
  lastError: string | null;
  /** Write raw input bytes to the remote shell. No-op if not connected. */
  sendInput: (data: string | Uint8Array) => void;
  /** Notify the server the local terminal dimensions changed. */
  sendResize: (cols: number, rows: number) => void;
  /** Tear down and prevent reconnects. */
  disconnect: () => void;
  /** Force a fresh connect attempt (after a terminal error / explicit disconnect). */
  reconnect: () => void;
  /**
   * Permanently close the shell. Sends a `{type:"close"}` control
   * frame so the server forces a full teardown (no parking) and
   * finalizes the audit row, then disconnects locally. Use when the
   * user explicitly closes a shell tab — distinct from `disconnect()`,
   * which lets the server park.
   */
  terminate: () => void;
}

/** Application close codes set by the API on terminal-state failures. */
const TERMINAL_CLOSE_CODES = new Set([4400, 4401, 4403, 4404, 4429]);

export function usePtyConnection({
  target,
  onBytes,
  onReady,
  onExit,
  onError,
  enabled,
  resumeToken,
}: UsePtyConnectionArgs): PtyConnection {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  // Refs hold "latest" so the long-lived effect closure doesn't capture
  // stale callbacks. Callers can swap onBytes / onExit / onError freely.
  const onBytesRef = useRef(onBytes);
  const onReadyRef = useRef(onReady);
  const onExitRef = useRef(onExit);
  const onErrorRef = useRef(onError);
  onBytesRef.current = onBytes;
  onReadyRef.current = onReady;
  onExitRef.current = onExit;
  onErrorRef.current = onError;

  // Latest resume token. Read once per connect attempt - we don't
  // hold it in the connect closure because the parent component can
  // swap it freely (e.g. after a resume_failed, the parent clears it
  // so the next connect goes fresh).
  const resumeTokenRef = useRef(resumeToken);
  resumeTokenRef.current = resumeToken;

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handshakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const connectRef = useRef<(() => Promise<void>) | null>(null);
  const attemptsRef = useRef(0);
  // Set to true when the user (or the hook teardown) explicitly killed
  // the connection — never reconnect in that case.
  const manualStopRef = useRef(false);
  // Set when a TERMINAL control frame arrived (exit / error). Prevents
  // the close handler from kicking off a reconnect after a clean exit.
  const terminalRef = useRef(false);

  const clearHandshakeTimer = useCallback(() => {
    if (handshakeTimerRef.current) {
      clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
  }, []);

  const clearTimers = useCallback(() => {
    clearHandshakeTimer();
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, [clearHandshakeTimer]);

  const teardownSocket = useCallback(() => {
    // A ticket can still be pending, and close events arrive asynchronously.
    // Neither may take ownership after this connection has been replaced.
    generationRef.current += 1;
    clearTimers();
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close(1000, "client_close");
      } catch {
        /* already closing */
      }
    }
    setIsConnected(false);
    setIsConnecting(false);
  }, [clearTimers]);

  const scheduleReconnect = useCallback(() => {
    if (manualStopRef.current || terminalRef.current) return;
    const attempt = attemptsRef.current + 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      setLastError("max_reconnects");
      return;
    }
    attemptsRef.current = attempt;
    setReconnectAttempts(attempt);
    // 1s → 2s → 4s
    const delay = 1000 * Math.pow(2, attempt - 1);
    reconnectTimerRef.current = setTimeout(() => {
      void connectRef.current?.();
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    if (!target) return;
    if (manualStopRef.current) return;
    if (wsRef.current) return; // already connected / connecting

    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation && !manualStopRef.current;

    setIsConnecting(true);
    setLastError(null);

    const transport = pickTransport(target);

    // Covers both ticket acquisition and the remote PTY opening after upgrade.
    // A reachable WebSocket without a ready frame must not spin indefinitely.
    handshakeTimerRef.current = setTimeout(() => {
      if (!isCurrent()) return;
      terminalRef.current = true;
      teardownSocket();
      setLastError("ssh_connect");
      onErrorRef.current?.(
        "ssh_connect",
        "Opening the terminal timed out. Check the server connection and try again.",
      );
    }, CONNECT_TIMEOUT_MS);

    let token: string;
    try {
      const t = await transport.requestTicket();
      token = t.token;
    } catch (err: any) {
      if (!isCurrent()) return;
      clearHandshakeTimer();
      setIsConnecting(false);
      const code: TerminalErrorCode = err?.status === 404 ? "server_not_found" : "ssh_auth";
      setLastError(code);
      onErrorRef.current?.(code, err?.message || "Failed to request session ticket");
      // Ticket failures are terminal — don't reconnect blindly against
      // an endpoint that just rejected us.
      return;
    }

    if (!isCurrent()) return;

    const protocols = [TERMINAL_SUBPROTOCOL_PREFIX + token];
    const rt = resumeTokenRef.current;
    if (rt) protocols.push(TERMINAL_RESUME_SUBPROTOCOL_PREFIX + rt);

    let ws: WebSocket;
    try {
      ws = new WebSocket(transport.buildWsUrl(), protocols);
    } catch (err: any) {
      clearHandshakeTimer();
      setIsConnecting(false);
      setLastError("transport");
      scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const ownsSocket = () => isCurrent() && wsRef.current === ws;

    ws.onopen = () => {
      if (!ownsSocket()) return;
      // Don't flip isConnected here — wait for {type:"ready"} from the
      // server (which confirms the remote PTY actually opened). The
      // open event just means TCP/TLS is up.
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* peer gone */
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (evt) => {
      if (!ownsSocket()) return;
      const data = evt.data;
      if (data instanceof ArrayBuffer) {
        onBytesRef.current(new Uint8Array(data));
        return;
      }
      if (typeof data === "string") {
        let msg: ServerControlMsg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          clearHandshakeTimer();
          setIsConnecting(false);
          setIsConnected(true);
          attemptsRef.current = 0;
          setReconnectAttempts(0);
          setLastError(null);
          onReadyRef.current?.({
            sessionId: msg.sessionId,
            resumeToken: msg.resumeToken,
            resumed: msg.resumed,
          });
          return;
        }
        if (msg.type === "exit") {
          terminalRef.current = true;
          onExitRef.current?.(msg.code, msg.signal);
          return;
        }
        if (msg.type === "error") {
          if (msg.code === "resume_failed") {
            // Transparent recovery: server says this exact token
            // doesn't match a live session. Clear our local copy
            // synchronously (so the imminent reconnect goes fresh),
            // notify the parent to drop the stored token, and reset
            // attempts so the next try doesn't backoff against
            // unrelated prior failures. We do NOT setLastError here —
            // the user shouldn't see a banner for a behavior they
            // can't act on.
            resumeTokenRef.current = null;
            attemptsRef.current = 0;
            setReconnectAttempts(0);
            setLastError(null);
            onErrorRef.current?.(msg.code, msg.message);
            // terminalRef stays false → onclose will scheduleReconnect.
            return;
          }
          // All other errors are terminal — surface to user, stop
          // reconnect.
          terminalRef.current = true;
          setLastError(msg.code);
          onErrorRef.current?.(msg.code, msg.message);
          return;
        }
        // pong → no-op (heartbeat already keeps the socket warm)
      }
    };

    ws.onclose = (evt) => {
      if (!ownsSocket()) return;
      wsRef.current = null;
      clearTimers();
      setIsConnected(false);
      setIsConnecting(false);
      if (manualStopRef.current || terminalRef.current) return;
      // Terminal application-level close codes — don't reconnect.
      if (TERMINAL_CLOSE_CODES.has(evt.code)) {
        setLastError(String(evt.code));
        return;
      }
      // Transient transport close → reconnect with backoff.
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (!ownsSocket()) return;
      // onclose will follow with a close code; defer logic to there so
      // we don't double-count attempts. Just record the symptom.
      setLastError("transport");
    };
  }, [
    target?.kind,
    target?.id,
    clearHandshakeTimer,
    clearTimers,
    scheduleReconnect,
    teardownSocket,
  ]);
  connectRef.current = connect;

  // ── Effect: lifecycle bound to (target, enabled) ────────────────────────
  // Key the effect on a stringified target so changing kind/id triggers
  // a fresh connect (and disconnects the old). Using the object reference
  // would re-fire on every render because callers build inline objects.
  const targetKey = target ? `${target.kind}:${target.id}` : null;
  useEffect(() => {
    if (!enabled || !target) return;
    manualStopRef.current = false;
    terminalRef.current = false;
    attemptsRef.current = 0;
    setReconnectAttempts(0);
    setLastError(null);
    void connect();
    return () => {
      manualStopRef.current = true;
      teardownSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, targetKey, connect, teardownSocket]);

  const sendInput = useCallback((data: string | Uint8Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (typeof data === "string") {
        // Binary frame so the server's onMessage routes it to the PTY
        // stdin path (string frames are reserved for JSON control).
        ws.send(new TextEncoder().encode(data));
      } else {
        ws.send(data);
      }
    } catch {
      /* peer gone */
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    } catch {
      /* peer gone */
    }
  }, []);

  const disconnect = useCallback(() => {
    manualStopRef.current = true;
    teardownSocket();
  }, [teardownSocket]);

  const terminate = useCallback(() => {
    // Send the explicit-close frame BEFORE tearing the socket down so
    // the server sees it. We don't await an ack — the server closes
    // the WS from its side as part of the forceClose teardown, which
    // our onclose handler observes.
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "close" }));
      } catch {
        /* peer gone */
      }
    }
    manualStopRef.current = true;
    terminalRef.current = true;
    teardownSocket();
  }, [teardownSocket]);

  const reconnect = useCallback(() => {
    manualStopRef.current = false;
    terminalRef.current = false;
    attemptsRef.current = 0;
    setReconnectAttempts(0);
    setLastError(null);
    teardownSocket();
    void connect();
  }, [connect, teardownSocket]);

  return {
    isConnecting,
    isConnected,
    reconnectAttempts,
    lastError,
    sendInput,
    sendResize,
    disconnect,
    reconnect,
    terminate,
  };
}
