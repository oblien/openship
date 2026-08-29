/**
 * Live per-project resource usage over SSE.
 *
 * Connects to GET /analytics/usage/stream, which emits the WHOLE project each tick
 * — overall totals plus one entry per service. That's deliberate: the summary card
 * and the per-service dots come from the same frame, so they can never render two
 * different moments. Fetching them separately would also mean N docker-stats calls
 * per tick over one SSH connection.
 *
 * Framing mirrors useMonitorStream (fetch + AbortController + a manual frame
 * buffer) rather than EventSource, because EventSource cannot send credentials or
 * custom headers through the dashboard's API proxy.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";

export interface ResourceUsage {
  cpuPercent: number;
  memoryMb: number;
  /** Cumulative block I/O, NOT disk space used. Labelled "Disk I/O" in the UI. */
  diskMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export type ServiceStatus =
  | "running"
  | "starting"
  | "restarting"
  | "failed"
  | "stopped";

export interface ServiceUsage {
  serviceId: string | null;
  name: string;
  containerId: string | null;
  status: ServiceStatus;
  usage: ResourceUsage | null;
}

export interface ProjectUsage {
  supported: boolean;
  reason?: string;
  overall: ResourceUsage;
  services: ServiceUsage[];
  capacity: { cpuCores: number | null; memoryMb: number | null };
  timestamp: string;
}

export interface UseProjectUsageStreamReturn {
  usage: ProjectUsage | null;
  isConnected: boolean;
  error: string | null;
  reconnect: () => void;
  disconnect: () => void;
}

export function useProjectUsageStream(
  projectId: string | null | undefined,
  enabled = true,
): UseProjectUsageStreamReturn {
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
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
    if (!projectId) {
      setUsage(null);
      setError(null);
      setIsConnected(false);
      return;
    }

    disconnect();
    const abort = new AbortController();
    abortRef.current = abort;
    bufferRef.current = "";

    const url = `${getApiBaseUrl()}${endpoints.analytics.usageStream}?${new URLSearchParams({ projectId })}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });

      // 404 here is a STATE, not a fault: no active deployment, or a runtime that
      // can't measure usage. Surface its message instead of "Connection failed",
      // and don't retry — reconnecting won't create a deployment.
      if (res.status === 404) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "No active deployment");
        return;
      }
      if (!res.ok || !res.body) {
        setError(`Connection failed (${res.status})`);
        return;
      }

      setIsConnected(true);
      setError(null);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        // Frames can split across chunks anywhere, so keep the tail until the next
        // read completes it.
        const buffer = bufferRef.current + decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        bufferRef.current = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventType = "";
          let dataStr = "";
          for (const line of part.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("event:")) eventType = trimmed.slice(6).trim();
            else if (trimmed.startsWith("data:")) dataStr = trimmed.slice(5).trim();
          }
          if (!dataStr) continue;
          try {
            if (eventType === "usage") {
              setUsage(JSON.parse(dataStr) as ProjectUsage);
              setError(null);
            } else if (eventType === "error") {
              setError((JSON.parse(dataStr) as { error?: string }).error || "Unknown error");
            }
            // `ping` (the streamSSE keep-alive) falls through — nothing to do.
          } catch {
            // Skip malformed events rather than tearing down a working stream.
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!abort.signal.aborted) setIsConnected(false);
    }
  }, [disconnect, projectId]);

  const reconnect = useCallback(() => {
    if (enabledRef.current) void connect();
  }, [connect]);

  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }
    // Small delay avoids a double-connect from React StrictMode's remount.
    const id = setTimeout(() => void connect(), 50);
    return () => {
      clearTimeout(id);
      disconnect();
    };
  }, [enabled, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { usage, isConnected, error, reconnect, disconnect };
}
