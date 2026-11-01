"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseSSE } from "@repo/core";
import { ResourceUsageSampleSchema, parseInput, type ResourceUsageSample } from "@repo/contracts";
import {
  ApiError,
  getActiveOrganizationId,
  getApiBaseUrl,
  getApiErrorMessage,
} from "@/lib/api/client";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { endpoints } from "@/lib/api/endpoints";
import type { ServerStats } from "@/lib/api/system";

export interface UseMonitorStreamReturn {
  stats: ServerStats | null;
  usage: ResourceUsageSample | null;
  history: ResourceUsageSample[];
  paused: boolean;
  isConnected: boolean;
  error: string | null;
  reconnect: () => void;
  disconnect: () => void;
}

/** One cancellable SSE connection per selected server. Reads never start it. */
export function useMonitorStream(
  serverId: string | null,
  enabled = true,
  format: "stats" | "usage" = "stats",
): UseMonitorStreamReturn {
  const scope = useCloudResourceKey();
  const resourceKey = `${scope}\0${serverId ?? ""}\0${format}`;
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [usageSamples, setUsageSamples] = useState<{
    key: string;
    history: ResourceUsageSample[];
  } | null>(null);
  const active = enabled && (format !== "usage" || visible);
  useEffect(() => {
    if (format !== "usage") return;
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [format]);
  const [sample, setSample] = useState<{ key: string; stats: ServerStats } | null>(null);
  const [connection, setConnection] = useState<{
    key: string;
    error: string | null;
    connected: boolean;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const targetRef = useRef(resourceKey);
  targetRef.current = resourceKey;
  const enabledRef = useRef(active);
  enabledRef.current = active;

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
      !abort.signal.aborted && abortRef.current === abort && targetRef.current === resourceKey;
    setConnection({ key: resourceKey, connected: false, error: null });
    const params = new URLSearchParams({ serverId });
    if (format === "usage") params.set("format", format);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (format !== "usage") return;
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        if (!current()) return;
        setConnection({
          key: resourceKey,
          connected: false,
          error: "Live usage is delayed. Retry to reconnect.",
        });
        abort.abort();
      }, 45_000);
    };
    arm();
    const organizationId = getActiveOrganizationId();
    let streamError: string | null = null;
    try {
      const response = await fetch(
        `${getApiBaseUrl()}${endpoints.system.monitorStream}?${params}`,
        {
          credentials: "include",
          headers: {
            Accept: "text/event-stream",
            ...(organizationId ? { "X-Organization-Id": organizationId } : {}),
          },
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
          await response.json().catch((diagnosticFailure) => {
            observeCaughtError(diagnosticFailure, "dashboard/hooks/useMonitorStream");
            return null;
          }),
        );
      if (
        !response.body ||
        (format === "usage" && !response.headers.get("content-type")?.includes("text/event-stream"))
      )
        throw new Error("Live monitoring is unavailable. Retry to reconnect.");
      setConnection({ key: resourceKey, connected: format === "stats", error: null });

      for await (const event of parseSSE(response.body)) {
        if (!current()) return;
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (event.event === "usage" && format === "usage") {
          const sample = parseInput(ResourceUsageSampleSchema, data);
          if (!Number.isFinite(Date.parse(sample.measuredAt)))
            throw new Error("Invalid live usage sample");
          setUsageSamples((previous) => ({
            key: resourceKey,
            history: [...(previous?.key === resourceKey ? previous.history : []), sample].slice(
              -60,
            ),
          }));
          arm();
          streamError = null;
          setConnection({ key: resourceKey, connected: true, error: null });
        } else if (event.event === "stats" && format === "stats") {
          setSample({ key: resourceKey, stats: data as ServerStats });
          streamError = null;
          setConnection({ key: resourceKey, connected: true, error: null });
        } else if (event.event === "error") {
          streamError =
            typeof data?.error === "string" ? data.error : "Live monitoring is unavailable.";
          setConnection({ key: resourceKey, connected: false, error: streamError });
          if (format === "usage") break;
        }
      }
      if (current())
        setConnection({
          key: resourceKey,
          connected: false,
          error: streamError ?? "Live monitoring disconnected. Retry to reconnect.",
        });
    } catch (error) {
      if (current())
        setConnection({ key: resourceKey, connected: false, error: getApiErrorMessage(error) });
    } finally {
      clearTimeout(deadline);
      abort.abort();
      if (abortRef.current === abort) abortRef.current = null;
    }
  }, [disconnect, serverId, format, resourceKey]);

  const reconnect = useCallback(() => {
    void connect();
  }, [connect]);
  useEffect(() => {
    if (!active) {
      disconnect();
      return;
    }
    // Avoid opening two connections during StrictMode's mount check.
    const timer = setTimeout(() => void connect(), 50);
    return () => {
      clearTimeout(timer);
      disconnect();
    };
  }, [connect, disconnect, active]);

  const history = usageSamples?.key === resourceKey ? usageSamples.history : [];
  return {
    usage: history.at(-1) ?? null,
    history,
    paused: enabled && format === "usage" && !visible,
    stats: sample?.key === resourceKey ? sample.stats : null,
    isConnected: active && connection?.key === resourceKey && connection.connected,
    error: connection?.key === resourceKey ? connection.error : null,
    reconnect,
    disconnect,
  };
}
