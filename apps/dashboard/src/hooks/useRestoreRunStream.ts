/**
 * Subscribe to a restore's live progress channel.
 *
 * Mirrors useBackupRunStream — same SSE shape, same survives-refresh
 * semantics. The server re-snapshots on reconnect so the wizard can
 * pick up where it left off even if the user reloaded mid-restore.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { getApiBaseUrl, getAuthToken, type BackupRestore } from "@/lib/api";

export type RestoreRunEvent =
  | { type: "snapshot"; restore: BackupRestore }
  | {
      type: "transition";
      status: BackupRestore["status"];
      bytesRestored?: number | null;
    }
  | {
      type: "complete";
      status: "succeeded" | "failed" | "cancelled" | "server_error";
      errorMessage?: string | null;
    };

export interface UseRestoreRunStreamResult {
  restore: BackupRestore | null;
  connected: boolean;
  error: Error | null;
}

export function useRestoreRunStream(restoreId: string | null): UseRestoreRunStreamResult {
  const [restore, setRestore] = useState<BackupRestore | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!restoreId) return;

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      try {
        const token = await getAuthToken();
        const res = await fetch(
          `${getApiBaseUrl()}backup-restores/${restoreId}/stream`,
          {
            headers: {
              Accept: "text/event-stream",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: ctrl.signal,
            credentials: "include",
          },
        );

        if (!res.ok || !res.body) {
          throw new Error(`SSE connection failed: ${res.status}`);
        }
        setConnected(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!ctrl.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nl: number;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            if (!block.trim()) continue;

            let eventName = "message";
            let dataLine = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
            }
            if (eventName === "ping" || !dataLine) continue;

            try {
              const ev = JSON.parse(dataLine) as RestoreRunEvent;
              if (ev.type === "snapshot") {
                setRestore(ev.restore);
              } else if (ev.type === "transition") {
                setRestore((prev) =>
                  prev
                    ? {
                        ...prev,
                        status: ev.status,
                        bytesRestored: ev.bytesRestored ?? prev.bytesRestored,
                      }
                    : prev,
                );
              } else if (ev.type === "complete") {
                setRestore((prev) =>
                  prev
                    ? {
                        ...prev,
                        status: ev.status,
                        errorMessage: ev.errorMessage ?? prev.errorMessage,
                      }
                    : prev,
                );
                ctrl.abort();
              }
            } catch {
              // ignore malformed events
            }
          }
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name !== "AbortError") {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        setConnected(false);
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [restoreId]);

  return { restore, connected, error };
}
