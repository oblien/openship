import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "@repo/core";
import type { BackupExecutor, ExecuteCommandOpts, ServiceHandle } from "../types";

/** A newly started database may still be running its image's temporary init
 * server. Producers choose an authenticated probe of the final server. */
export async function waitForDatabaseCommand(
  service: ServiceHandle,
  executor: BackupExecutor,
  command: string[],
  options: ExecuteCommandOpts = {},
) {
  const deadline = Date.now() + 120_000;
  do {
    options.signal?.throwIfAborted();
    const result = await executor.execStream(service, command, {
      ...options,
      timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())),
    });
    result.stdout.resume();
    const exit = await result.awaitExit;
    result.stdout.destroy();
    if (exit.code === 0) return;
    if (Date.now() >= deadline) break;
    await delay(1000, undefined, { signal: options.signal });
  } while (Date.now() < deadline);
  throw new AppError(
    "The database did not become ready within two minutes. Check its credentials and deployment logs before retrying; no backup data was applied to it.",
    409,
    "BACKUP_SERVICE_NOT_READY",
  );
}
