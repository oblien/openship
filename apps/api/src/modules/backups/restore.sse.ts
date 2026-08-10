/**
 * Restore-run SSE channel. Mirrors backup.sse.ts shape.
 */

import type { BackupRestore, BackupRestoreStatus } from "@repo/db";
import { createRunBus } from "../../lib/run-sse";

export type RestoreRunEvent =
  | {
      type: "transition";
      status: BackupRestoreStatus;
      bytesRestored?: number | null;
    }
  | {
      type: "snapshot";
      restore: BackupRestore;
    }
  /** Non-fatal advisory — the restore continues. Today: an artifact that could
   *  only be size-checked, or a policy that deferred verification to apply time.
   *  Never terminal, so it does not appear in TERMINAL below. */
  | {
      type: "warning";
      message: string;
    }
  /**
   * Whether the apply has passed the point of no return — published the instant
   * the first write into the target begins, and again when a cancel is accepted
   * while the row is still `applying`.
   *
   * This drives what the cancel button is allowed to promise: before the first
   * write a cancel costs nothing, after it the target holds partial data. Not
   * terminal — the row is still running when this fires.
   */
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

const TERMINAL: ReadonlySet<BackupRestoreStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "server_error",
]);

export const restoreRunBus = createRunBus<RestoreRunEvent>(
  (e) =>
    e.type === "complete" ||
    (e.type === "transition" && TERMINAL.has(e.status)),
);
