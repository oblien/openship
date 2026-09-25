/**
 * Process-local backup notifications, keyed by run ID. The orchestrator
 * persists each transition before publishing its notification here.
 *
 * The shared run-events adapter subscribes before reading the saved row and
 * coalesces these hints into durable snapshots. It also reconciles without
 * notifications, since workers can run in another process. Terminal state,
 * bytes and timestamps come from storage before a client stream closes.
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
