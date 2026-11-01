/**
 * Subscribe to a restore's live progress channel.
 *
 * Mirrors useBackupRunStream — same SSE shape, same survives-refresh
 * semantics. The server re-snapshots on reconnect so the wizard can
 * pick up where it left off even if the user reloaded mid-restore.
 */

"use client";

import { useState } from "react";
import type { BackupRestore } from "@/lib/api";
import { useRunEvents, type RunEventsState } from "./useRunEvents";

export type RestoreRunEvent =
  | { type: "snapshot"; restore: BackupRestore }
  | {
      type: "transition";
      status: BackupRestore["status"];
      bytesRestored?: number | null;
      meta?: BackupRestore["meta"];
    }
  /** Non-fatal: the restore continues. An artifact that could only be
   *  size-checked, or a policy that deferred verification to apply time. */
  | { type: "warning"; message: string }
  /** The apply crossed (or is confirmed not to have crossed) the point of no
   *  return. Drives what the cancel button is allowed to promise. */
  | {
      type: "destructive";
      destructive: boolean;
      cancelRequested?: boolean;
      source?: string | null;
    }
  | {
      type: "complete";
      status: "succeeded" | "failed" | "cancelled" | "server_error";
      errorMessage?: string | null;
    };

export interface UseRestoreRunStreamResult extends RunEventsState {
  restore: BackupRestore | null;
  /** Advisories accumulated over the run — shown alongside progress, not
   *  instead of it, since none of them stop the restore. */
  warnings: string[];
}

export function useRestoreRunStream(restoreId: string | null): UseRestoreRunStreamResult {
  const [restore, setRestore] = useState<BackupRestore | null>(null);
  const [advisories, setAdvisories] = useState<{ id: string | null; messages: string[] }>({
    id: null,
    messages: [],
  });
  const stream = useRunEvents<BackupRestore>(
    restoreId ? `backup-restores/${encodeURIComponent(restoreId)}/stream` : null,
    (snapshot) => {
      if (snapshot.id !== restoreId) throw new Error("Restore progress belongs to another run");
      setRestore(snapshot);
    },
    {
      snapshotKey: "restore",
      onEvent(message) {
        const event = message as RestoreRunEvent;
        if (event.type === "warning") {
          setAdvisories((previous) => {
            const messages = previous.id === restoreId ? previous.messages : [];
            return {
              id: restoreId,
              messages: messages.includes(event.message) ? messages : [...messages, event.message],
            };
          });
          return;
        }
        setRestore((previous) => {
          if (!previous || previous.id !== restoreId) return previous;
          if (event.type === "transition")
            return {
              ...previous,
              status: event.status,
              bytesRestored: event.bytesRestored ?? previous.bytesRestored,
              meta: event.meta === undefined ? previous.meta : event.meta,
            };
          if (event.type === "destructive")
            return {
              ...previous,
              meta: {
                ...(previous.meta ?? {}),
                destructive: event.destructive,
                ...(event.source ? { destructiveSource: event.source } : {}),
              },
              cancelRequested: event.cancelRequested ?? previous.cancelRequested,
            };
          if (event.type === "complete")
            return {
              ...previous,
              status: event.status,
              errorMessage: event.errorMessage ?? previous.errorMessage,
            };
          return previous;
        });
      },
    },
  );
  return {
    restore: restoreId && restore?.id === restoreId ? restore : null,
    warnings: advisories.id === restoreId ? advisories.messages : [],
    ...stream,
  };
}
