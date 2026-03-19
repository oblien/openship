/**
 * Hook for streaming live server stats via SSE.
 *
 * Connects to GET /system/monitor/stream and receives real-time
 * CPU, memory, disk, uptime, and load average updates every ~3s.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";
import type { ServerStats } from "@/lib/api/system";

export interface UseMonitorStreamReturn {
  /** Current stats (null until first data received) */
  stats: ServerStats | null;
  /** Connection state */
  isConnected: boolean;
  /** Error (if any) */
  error: string | null;
  /** Manually reconnect */
  reconnect: () => void;
  /** Disconnect */
  disconnect: () => void;
}

export function useMonitorStream(
  serverId: string | null,
  /** Set to false to disable streaming (e.g. when tab is not visible) */
  enabled = true,
): UseMonitorStreamReturn {
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bufferRef = useRef("");
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const disconnect = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const connect = useCallback(async () => {
    if (!serverId) {
      setStats(null);
      setError(null);
      setIsConnected(false);
      return;
    }

    disconnect();

    const abort = new AbortController();
    abortRef.current = abort;
    bufferRef.current = "";

    const baseUrl = getApiBaseUrl();
    const params = new URLSearchParams({ serverId });
    const url = `${baseUrl}${endpoints.system.monitorStream}?${params.toString()}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        setError(`Connection failed (${res.status})`);
        return;
      }

      setIsConnected(true);
      setError(null);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const buffer = bufferRef.current + chunk;
        const parts = buffer.split("\n\n");
        bufferRef.current = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;

          let eventType = "";
          let dataStr = "";

          for (const line of part.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("event:")) {
              eventType = trimmed.substring(6).trim();
            } else if (trimmed.startsWith("data:")) {
              dataStr = trimmed.substring(5).trim();
            }
          }

          if (!dataStr) continue;

          try {
            if (eventType === "stats") {
              const parsed = JSON.parse(dataStr) as ServerStats;
              setStats(parsed);
              setError(null);
            } else if (eventType === "error") {
              const parsed = JSON.parse(dataStr);
              setError(parsed.error || "Unknown error");
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      if (!abort.signal.aborted) {
        setIsConnected(false);
      }
    }
  }, [disconnect, serverId]);

  const reconnect = useCallback(() => {
    if (enabledRef.current) void connect();
  }, [connect]);

  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }

    // Small delay avoids double-connect from React StrictMode remount
    const id = setTimeout(() => void connect(), 50);
    return () => {
      clearTimeout(id);
      disconnect();
    };
  }, [enabled, serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { stats, isConnected, error, reconnect, disconnect };
}
