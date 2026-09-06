"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLogStream } from "@/hooks/useSSEConnection";
import { endpoints } from "@/lib/api/endpoints";
import TerminalSurface from "../TerminalSurface";
import { shouldRetryLiveStream } from "./live-stream-policy";

interface LiveServiceLogsTerminalProps {
  projectId: string;
  serviceId: string;
  /** Only the visible tab owns the single live SSE connection (#667). */
  active: boolean;
  theme?: "light" | "dark";
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;

/**
 * Post-deploy runtime log stream for one compose service tab. The server
 * backfills `?tail=` before going live; the connection lives only while the
 * tab is active AND the xterm is ready (earlier lines would be discarded),
 * and is dropped on tab switch, unmount, or a natural container-stream end.
 */
export const LiveServiceLogsTerminal: React.FC<LiveServiceLogsTerminalProps> = ({
  projectId,
  serviceId,
  active,
  theme,
}) => {
  const terminalRef = useRef<any>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  // Natural end reported by the server — stop retrying once set.
  const exitedRef = useRef(false);
  // Set while WE are tearing the stream down on purpose, so the hook's
  // onDisconnect/onError never schedules work after unmount.
  const stoppingRef = useRef(false);
  const attemptsRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Written through an effect-synced ref because the retry policy closes over
  // state that itself depends on the stream hook (declared below).
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const logStream = useLogStream({
    terminalRef,
    autoWriteToTerminal: true,
    callbacks: {
      onError: (message) => {
        if (!stoppingRef.current) {
          terminalRef.current?.write(`\x1b[1;31m[${message}]\x1b[0m\r\n`);
        }
      },
      onContainerExit: (exitCode, message) => {
        exitedRef.current = true;
        clearRetryTimer();
        if (exitCode !== 0 && !stoppingRef.current && terminalRef.current) {
          terminalRef.current.write(
            `\x1b[1;31m[${message || `Container exited with code ${exitCode}`}]\x1b[0m\r\n`,
          );
        } else if (!stoppingRef.current && terminalRef.current) {
          terminalRef.current.write(`\x1b[2m[${message || "Log stream ended"}]\x1b[0m\r\n`);
        }
      },
    },
    onDisconnect: () => scheduleReconnectRef.current(),
    onError: () => scheduleReconnectRef.current(),
  });

  const connect = useCallback(async () => {
    // Every connection re-backfills ?tail=100; a stale buffer would duplicate
    // those lines, so each (re)connection starts from a clean slate.
    terminalRef.current?.reset();
    await logStream.connect(`${endpoints.services.logsStream(projectId, serviceId)}?tail=100`);
  }, [logStream, projectId, serviceId]);

  // Bounded auto-retry for unexpected drops (transport errors, API restarts).
  // Deliberate teardowns flip stoppingRef first and never reach here.
  const scheduleReconnect = useCallback(() => {
    if (
      !shouldRetryLiveStream({
        exited: exitedRef.current,
        stopping: stoppingRef.current,
        active,
        attempts: attemptsRef.current,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
      })
    ) {
      return;
    }
    attemptsRef.current += 1;
    clearRetryTimer();
    retryTimerRef.current = setTimeout(() => {
      connect().catch(() => scheduleReconnectRef.current());
    }, RECONNECT_DELAY_MS);
  }, [active, connect, clearRetryTimer]);

  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  useEffect(() => {
    // Wait for BOTH the visible tab and the async-initialized xterm: lines
    // streamed before onReady have no terminal to land in.
    if (!active || !terminalReady || !projectId || !serviceId) return;
    stoppingRef.current = false;
    exitedRef.current = false;
    attemptsRef.current = 0;
    connect().catch(() => scheduleReconnectRef.current());
    return () => {
      stoppingRef.current = true;
      clearRetryTimer();
      logStream.disconnect();
    };
  }, [active, terminalReady, projectId, serviceId, connect, logStream, clearRetryTimer]);

  return (
    <div
      className="absolute inset-0"
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
      aria-hidden={!active}
    >
      <TerminalSurface
        terminalRef={terminalRef}
        onReady={(terminal) => {
          terminalRef.current = terminal;
          setTerminalReady(true);
        }}
        theme={theme}
      />
    </div>
  );
};
