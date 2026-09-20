/**
 * Backup-run SSE channel — mirrors the deployment session-manager pattern.
 *
 * Each run gets a topic keyed by runId. Subscribers receive every FSM
 * transition + interim progress events; when the run reaches a terminal
 * state, all subscribers get a final event and the channel closes.
 *
 * Survives dashboard refresh:
 *   - The `backup_run` DB row is the source of truth. SSE amplifies it.
 *   - On (re)connect, the route handler first sends a `snapshot` event
 *     with the current DB row, then attaches as a live subscriber for
 *     subsequent events.
 *   - If the run already finished by the time the client reconnects,
 *     the snapshot event has terminal status and the stream closes
 *     cleanly.
 */

import type { BackupRun, BackupRunStatus } from "@repo/db";
import { createRunBus } from "../../lib/run-bus";

export type BackupRunEvent =
  | {
      type: "transition";
      status: BackupRunStatus;
      bytesTransferred?: number | null;
      artifacts?: unknown[];
    }
  | {
      type: "progress";
      bytesTransferred: number;
      /** Optional per-artifact label for the bar. */
      currentArtifact?: string;
    }
  | {
      type: "snapshot";
      run: BackupRun;
    }
  | {
      type: "complete";
      status: "succeeded" | "failed" | "cancelled" | "server_error";
      errorMessage?: string | null;
    };

const TERMINAL_STATUSES: ReadonlySet<BackupRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "server_error",
]);

export const backupRunBus = createRunBus<BackupRunEvent>(
  (event) =>
    event.type === "complete" ||
    (event.type === "transition" && TERMINAL_STATUSES.has(event.status)),
);
