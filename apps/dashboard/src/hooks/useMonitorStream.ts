"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseSSE } from "@repo/core";
import { ApiError, getApiBaseUrl, getApiErrorMessage } from "@/lib/api/client";
import { endpoints } from "@/lib/api/endpoints";
import type { ServerStats } from "@/lib/api/system";

export interface UseMonitorStreamReturn {
  stats: ServerStats | null;
  isConnected: boolean;
  error: string | null;
  reconnect: () => void;
  disconnect: () => void;
}

/** One cancellable SSE connection per selected server. Reads never start it. */
export function useMonitorStream(serverId: string | null, enabled = true): UseMonitorStreamReturn {
  const [sample, setSample] = useState<{ serverId: string; stats: ServerStats } | null>(null);
  const [connection, setConnection] = useState<{
    serverId: string;
    error: string | null;
    connected: boolean;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const targetRef = useRef(serverId);
  targetRef.current = serverId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const disconnect = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setConnection((current) => (current ? { ...current, connected: false } : null));
  }, []);

  const connect = useCallback(async () => {
    disconnect();
    if (!serverId || !enabledRef.current) return;

    const abort = new AbortController();
    abortRef.current = abort;
    const current = () =>
      !abort.signal.aborted && abortRef.current === abort && targetRef.current === serverId;
    setConnection({ serverId, connected: false, error: null });
    const params = new URLSearchParams({ serverId });
    let streamError: string | null = null;
    try {
      const response = await fetch(
        `${getApiBaseUrl()}${endpoints.system.monitorStream}?${params}`,
        {
          credentials: "include",
          headers: { Accept: "text/event-stream" },
          signal: abort.signal,
        },
      );
      if (!current()) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok)
        throw new ApiError(
          response.status,
          response.statusText,
          await response.json().catch(() => null),
        );
      if (!response.body) throw new Error("Live monitoring is unavailable. Retry to reconnect.");
      setConnection({ serverId, connected: true, error: null });

      for await (const event of parseSSE(response.body)) {
        if (!current()) return;
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (event.event === "stats") {
          setSample({ serverId, stats: data as ServerStats });
          streamError = null;
          setConnection({ serverId, connected: true, error: null });
        } else if (event.event === "error") {
          streamError =
            typeof data?.error === "string" ? data.error : "Live monitoring is unavailable.";
          setConnection({ serverId, connected: true, error: streamError });
        }
      }
      if (current())
        setConnection({
          serverId,
          connected: false,
          error: streamError ?? "Live monitoring disconnected. Retry to reconnect.",
        });
    } catch (error) {
      if (current())
        setConnection({ serverId, connected: false, error: getApiErrorMessage(error) });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  }, [disconnect, serverId]);

  const reconnect = useCallback(() => {
    void connect();
  }, [connect]);
  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }
    // Avoid opening two connections during StrictMode's mount check.
    const timer = setTimeout(() => void connect(), 50);
    return () => {
      clearTimeout(timer);
      disconnect();
    };
  }, [connect, disconnect, enabled]);

  return {
    stats: sample?.serverId === serverId ? sample.stats : null,
    isConnected: enabled && connection?.serverId === serverId && connection.connected,
    error: connection?.serverId === serverId ? connection.error : null,
    reconnect,
    disconnect,
  };
}
