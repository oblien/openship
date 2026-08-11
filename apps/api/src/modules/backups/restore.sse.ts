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
