/**
 * Whether a stop/start/destroy error is ignorable (already in the desired
 * state) versus a real failure that must not be reported as success.
 */
import { safeErrorMessage } from "@repo/core";

export interface ContainerOpFailure {
  name: string;
  containerId: string;
  reason: string;
}

export type ContainerOpKind = "stop" | "start" | "destroy";

function opMessage(err: unknown): { code?: number; msg: string } {
  const any = err as {
    statusCode?: number;
    status?: number;
    message?: string;
    json?: { message?: string };
  };
  return {
    code: any.statusCode ?? any.status,
    msg: `${any.message ?? ""} ${any.json?.message ?? ""}`.toLowerCase(),
  };
}

/**
 * Start and stop do not share a classifier. A missing container is fine for
 * stop/destroy (already gone) and a failed restore for start.
 */
export function classifyContainerOpError(err: unknown, kind: ContainerOpKind): "benign" | "failed" {
  const { code, msg } = opMessage(err);
  if (code === 304 || /not modified|already (stopped|started|paused)/.test(msg)) return "benign";
  if (kind === "start") return "failed";
  if (code === 404 || /no such container|is not running/.test(msg)) return "benign";
  return "failed";
}

/** Run `op` for every scanned container. Benign errors depend on `kind`. */
export async function runContainerOps(
  ids: Record<string, string>,
  op: (containerId: string) => Promise<void>,
  kind: ContainerOpKind,
): Promise<ContainerOpFailure[]> {
  const failed: ContainerOpFailure[] = [];
  for (const [name, containerId] of Object.entries(ids)) {
    try {
      await op(containerId);
    } catch (err) {
      if (classifyContainerOpError(err, kind) === "benign") continue;
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
