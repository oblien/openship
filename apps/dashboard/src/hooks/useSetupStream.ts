/**
 * Hook for streaming system setup install logs via SSE.
 *
 * Connects to POST /system/install/stream (start new) or
 * GET /system/install/stream?id=xxx (attach to existing).
 *
 * Provides real-time log lines and component progress updates.
 */

import { useCallback, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/api";
import type {
  SetupLogEvent,
  SetupProgressEvent,
  SetupCompleteEvent,
  SetupComponentProgress,
} from "@/lib/api/system";

export interface UseSetupStreamCallbacks {
  onLog?: (entry: SetupLogEvent) => void;
  onProgress?: (components: SetupComponentProgress[]) => void;
  onComplete?: (event: SetupCompleteEvent) => void;
  onError?: (error: Error) => void;
}

export interface UseSetupStreamReturn {
  /** Start a new install session */
  startInstall: (components: string[], config?: Record<string, unknown>) => Promise<void>;
  /** Attach to an existing session */
  attachToSession: (sessionId?: string) => Promise<void>;
  /** Disconnect */
  disconnect: () => void;
  /** Current connection state */
  isConnected: boolean;
  isConnecting: boolean;
  /** Current component progress */
  components: SetupComponentProgress[];
  /** All log entries received so far */
  logs: SetupLogEvent[];
  /** Whether the session has completed */
  isDone: boolean;
  /** Final status */
  finalStatus: "completed" | "failed" | null;
  error: Error | null;
}

export function useSetupStream(
  callbacks: UseSetupStreamCallbacks = {},
): UseSetupStreamReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [components, setComponents] = useState<SetupComponentProgress[]>([]);
  const [logs, setLogs] = useState<SetupLogEvent[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [finalStatus, setFinalStatus] = useState<"completed" | "failed" | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bufferRef = useRef("");
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const processSSEBuffer = useCallback((chunk: string) => {
    const buffer = bufferRef.current + chunk;
    const parts = buffer.split("\n\n");
    bufferRef.current = parts.pop() || "";

    for (const part of parts) {
      if (!part.trim()) continue;

      let dataStr = "";
      for (const line of part.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const d = trimmed.substring(5).trim();
          dataStr = dataStr ? dataStr + "\n" + d : d;
        }
      }

      if (!dataStr) continue;

      let json: any;
      try {
        json = JSON.parse(dataStr);
      } catch {
        continue;
      }

      if (json.type === "log") {
        const entry = json as SetupLogEvent;
        setLogs((prev) => [...prev, entry]);
        callbacksRef.current.onLog?.(entry);
      } else if (json.type === "progress") {
        const event = json as SetupProgressEvent;
        if (event.components) {
          setComponents(event.components);
          callbacksRef.current.onProgress?.(event.components);
        }
      } else if (json.type === "complete") {
        const event = json as SetupCompleteEvent;
        setComponents(event.components);
        setFinalStatus(event.status);
        setIsDone(true);
        callbacksRef.current.onComplete?.(event);
      }
    }
  }, []);

  const connectToStream = useCallback(async (
    url: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ) => {
    // Cleanup previous connection
    if (abortRef.current) {
      abortRef.current.abort();
    }

    setIsConnecting(true);
    setError(null);
    setIsDone(false);
    setFinalStatus(null);
    bufferRef.current = "";

    // Only reset logs/components for new installs, not attachments
    if (method === "POST") {
      setLogs([]);
      setComponents([]);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errMsg = response.statusText;
        try {
          const json = await response.json();
          errMsg = json.error || json.message || errMsg;
        } catch {}
        throw new Error(errMsg);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader available");

      setIsConnected(true);
      setIsConnecting(false);

      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        processSSEBuffer(chunk);
      }

      setIsConnected(false);
    } catch (err: any) {
      if (err.name === "AbortError") {
        setIsConnected(false);
      } else {
        setError(err);
        setIsConnected(false);
        callbacksRef.current.onError?.(err);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [processSSEBuffer]);

  const startInstall = useCallback(async (
    componentNames: string[],
    config?: Record<string, unknown>,
  ) => {
    const baseUrl = getApiBaseUrl();
    const url = `${baseUrl}system/install/stream`;
    await connectToStream(url, "POST", {
      components: componentNames,
      ...(config ? { config } : {}),
    });
  }, [connectToStream]);

  const attachToSession = useCallback(async (sessionId?: string) => {
    const baseUrl = getApiBaseUrl();
    const params = sessionId ? `?id=${encodeURIComponent(sessionId)}` : "";
    const url = `${baseUrl}system/install/stream${params}`;
    await connectToStream(url, "GET");
  }, [connectToStream]);

  const disconnect = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsConnected(false);
    setIsConnecting(false);
    bufferRef.current = "";
  }, []);

  return {
    startInstall,
    attachToSession,
    disconnect,
    isConnected,
    isConnecting,
    components,
    logs,
    isDone,
    finalStatus,
    error,
  };
}
