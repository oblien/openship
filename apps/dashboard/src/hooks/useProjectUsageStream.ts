/**
 * Live per-project resource usage over SSE.
 *
 * Connects to GET /analytics/usage/stream, which emits the WHOLE project each tick
 * — overall totals plus one entry per service. That's deliberate: the summary card
 * and the per-service dots come from the same frame, so they can never render two
 * different moments. Fetching them separately would also mean N docker-stats calls
 * per tick over one SSH connection.
 *
 * Uses the shared authenticated SSE transport, including cancellation and deadlines.
 * A failed observation keeps its last sample and offers a manual, read-only reconnect.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getActiveOrganizationId, getApiBaseUrl, getApiErrorMessage } from "@/lib/api/client";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { useSSEStream, type SSEMessage } from "./useSSEStream";
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
  isConnecting: boolean;
  error: string | null;
  reconnect: () => void;
  disconnect: () => void;
}

export function useProjectUsageStream(
  projectId: string | null | undefined,
  enabled = true,
): UseProjectUsageStreamReturn {
  const scope = useCloudResourceKey();
  const key = projectId ? `${scope}\0${projectId}` : null;
  const keyRef = useRef(key);
  keyRef.current = key;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [sample, setSample] = useState<{ key: string; usage: ProjectUsage } | null>(null);
  const [connection, setConnection] = useState<{
    key: string;
    connected: boolean;
    connecting: boolean;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ownerRef = useRef<{
    key: string;
    active: boolean;
    connecting: boolean;
    answered: boolean;
  } | null>(null);
  const currentOwner = useCallback(() => {
    const owner = ownerRef.current;
    return enabledRef.current && owner?.active && owner.key === keyRef.current ? owner : null;
  }, []);
  const onError = useCallback(
    (error: Error) => {
      const owner = currentOwner();
      if (!owner) return;
      owner.connecting = false;
      setConnection({
        key: owner.key,
        connected: false,
        connecting: false,
        error: getApiErrorMessage(error),
      });
    },
    [currentOwner],
  );
  const stream = useSSEStream({
    autoWriteToTerminal: false,
    onConnect: useCallback(() => {
      const owner = currentOwner();
      if (!owner) return;
      setConnection((previous) => ({
        key: owner.key,
        connected: true,
        connecting: true,
        error: previous?.key === owner.key ? previous.error : null,
      }));
    }, [currentOwner]),
    onDisconnect: useCallback(() => {
      const owner = currentOwner();
      if (!owner) return;
      owner.connecting = false;
      setConnection((previous) => ({
        key: owner.key,
        connected: false,
        connecting: false,
        error:
          (previous?.key === owner.key ? previous.error : null) ??
          "Live monitoring disconnected. Retry to reconnect.",
      }));
    }, [currentOwner]),
    onError,
    onRawMessage: useCallback(
      (message: SSEMessage) => {
        const owner = currentOwner();
        if (!owner || (message.type !== "usage" && message.type !== "error")) return;
        owner.answered = true;
        owner.connecting = false;
        if (message.type === "usage") {
          setSample({ key: owner.key, usage: message as unknown as ProjectUsage });
        }
        setConnection({
          key: owner.key,
          connected: true,
          connecting: false,
          error:
            message.type === "error"
              ? typeof message.error === "string"
                ? message.error
                : "Live monitoring is unavailable."
              : null,
        });
      },
      [currentOwner],
    ),
  });
  const connect = stream.connect;
  const close = stream.disconnect;

  useEffect(() => {
    if (!key || !projectId || !enabled) return;
    const owner = { key, active: true, connecting: true, answered: false };
    ownerRef.current = owner;
    setConnection((previous) => ({
      key,
      connected: false,
      connecting: true,
      error: previous?.key === key ? previous.error : null,
    }));
    let firstSample: ReturnType<typeof setTimeout> | undefined;
    // StrictMode's first mount must not open an extra monitoring subscription.
    const start = setTimeout(() => {
      if (!owner.active) return;
      firstSample = setTimeout(() => {
        if (!owner.active || owner.answered) return;
        onError(new Error("Loading resource usage timed out. Retry to reconnect."));
        close();
      }, 60_000);
      const organizationId = getActiveOrganizationId();
      void connect(
        `${getApiBaseUrl()}${endpoints.analytics.usageStream}?${new URLSearchParams({ projectId })}`,
        {
          headers: {
            Accept: "text/event-stream",
            ...(organizationId ? { "X-Organization-Id": organizationId } : {}),
          },
          connectTimeoutMs: 15_000,
          idleTimeoutMs: 60_000,
        },
      ).finally(() => clearTimeout(firstSample));
    }, 50);
    return () => {
      owner.active = false;
      clearTimeout(start);
      clearTimeout(firstSample);
      close();
    };
  }, [key, projectId, enabled, attempt, connect, close, onError]);

  const disconnect = useCallback(() => {
    if (ownerRef.current) {
      ownerRef.current.active = false;
      ownerRef.current.connecting = false;
    }
    close();
    setConnection((previous) =>
      previous ? { ...previous, connected: false, connecting: false } : null,
    );
  }, [close]);
  const reconnect = useCallback(() => {
    if (!enabledRef.current || !keyRef.current || ownerRef.current?.connecting) return;
    if (ownerRef.current) ownerRef.current.connecting = true;
    setAttempt((value) => value + 1);
  }, []);

  return {
    usage: sample?.key === key ? sample.usage : null,
    isConnected: enabled && connection?.key === key && connection.connected,
    isConnecting: enabled && !!key && (connection?.key === key ? connection.connecting : true),
    error: connection?.key === key ? connection.error : null,
    reconnect,
    disconnect,
  };
}
