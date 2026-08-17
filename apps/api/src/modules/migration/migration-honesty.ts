/**
 * Whether a stop/start/destroy error is ignorable (already in the desired
 * state, or the container is gone) versus a real failure that must not be
 * reported as success.
 */
import { safeErrorMessage } from "@repo/core";

export interface ContainerOpFailure {
  name: string;
  containerId: string;
  reason: string;
}

export function classifyContainerOpError(err: unknown): "benign" | "failed" {
  const any = err as {
    statusCode?: number;
    status?: number;
    message?: string;
    json?: { message?: string };
  };
  const code = any.statusCode ?? any.status;
  // dockerode: 304 = already stopped/started, 404 = gone.
  if (code === 304 || code === 404) return "benign";
  const msg = `${any.message ?? ""} ${any.json?.message ?? ""}`.toLowerCase();
  if (
    /no such container|not found|already (stopped|started|paused)|is not running|not modified/.test(
      msg,
    )
  ) {
    return "benign";
  }
  return "failed";
}

/** Run `op` for every scanned container. Missing / already-there is fine. */
export async function runContainerOps(
  ids: Record<string, string>,
  op: (containerId: string) => Promise<void>,
): Promise<ContainerOpFailure[]> {
  const failed: ContainerOpFailure[] = [];
  for (const [name, containerId] of Object.entries(ids)) {
    try {
      await op(containerId);
    } catch (err) {
      if (classifyContainerOpError(err) === "benign") continue;
      failed.push({ name, containerId, reason: safeErrorMessage(err) });
    }
  }
  return failed;
}

export function stopFailuresMessage(failed: ContainerOpFailure[]): string {
  const which = failed
    .map((f) => `${f.name} (${f.containerId.slice(0, 12)}: ${f.reason})`)
    .join("; ");
  return (
    `Failed to stop ${failed.length} source container(s) before copying data — ` +
    `the source is still running, so the copy would be inconsistent: ${which}`
  );
}

export function restartFailuresMessage(failed: ContainerOpFailure[]): string {
  const which = failed
    .map((f) => `${f.name} (${f.containerId.slice(0, 12)}: ${f.reason})`)
    .join("; ");
  return (
    `Failed to restart ${failed.length} source container(s) — the original stack is down: ${which}`
  );
}

/** A rollback that left the source down must not claim `rolled_back`. */
export function rollbackTerminalStatus(restartFailed: ContainerOpFailure[]): "rolled_back" | "failed" {
  return restartFailed.length === 0 ? "rolled_back" : "failed";
}

/** Cutover that left source containers running must not claim `succeeded`. */
export function cutoverTerminalStatus(leftBehind: ContainerOpFailure[]): "succeeded" | "failed" {
  return leftBehind.length === 0 ? "succeeded" : "failed";
}
