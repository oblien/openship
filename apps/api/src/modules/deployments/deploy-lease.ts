/**
 * Per-project execution lease. The one-active unique index only serializes
 * INSERT of queued/building/deploying; cancel drops that slot while host work
 * may still be running. This lease is held until the worker exits and leftovers
 * are aborted.
 */
import { AppError, shellQuote } from "@repo/core";
import { repos, withAdvisoryLock, type Deployment } from "@repo/db";
import type { CommandExecutor } from "@repo/adapters";
import { mountedReleaseHostRoot } from "./mounted-release.config";

export const DEPLOY_CANCELLED = "DEPLOYMENT_CANCELLED";
export type ReleasePhase = "fetching" | "preparing" | "activating" | "health";

export function cancelledError(): AppError {
  return new AppError("Deployment cancelled", 409, DEPLOY_CANCELLED);
}

export function isCancelledError(error: unknown): boolean {
  return error instanceof AppError && error.code === DEPLOY_CANCELLED;
}

export function mountedReleaseBuilderName(deploymentId: string): string {
  return `openship-release-${deploymentId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

const runs = new Map<string, AbortController>();

export function beginDeployRun(deploymentId: string): AbortSignal {
  runs.get(deploymentId)?.abort();
  const abort = new AbortController();
  runs.set(deploymentId, abort);
  return abort.signal;
}

export function requestDeployAbort(deploymentId: string): void {
  runs.get(deploymentId)?.abort();
}

export function endDeployRun(deploymentId: string): void {
  runs.delete(deploymentId);
}

export async function claimDeployLease(projectId: string, deploymentId: string): Promise<boolean> {
  return withAdvisoryLock(`deploy-lease:${projectId}`, () =>
    repos.project.claimDeployLease(projectId, deploymentId),
  );
}

export async function releaseDeployLease(projectId: string, deploymentId: string): Promise<boolean> {
  return repos.project.releaseDeployLease(projectId, deploymentId);
}

export async function assertReleaseNotCancelled(deploymentId: string): Promise<void> {
  const row = await repos.deployment.findById(deploymentId);
  if (!row || row.status === "cancelled") throw cancelledError();
}

export function releaseLaneMeta(dep: Pick<Deployment, "meta">): {
  deploymentLane?: string;
  releasePreviousCurrent?: string;
  mountedReleaseRoot?: string;
} {
  return (dep.meta ?? {}) as {
    deploymentLane?: string;
    releasePreviousCurrent?: string;
    mountedReleaseRoot?: string;
  };
}

export function currentPointsAtDeployment(current: string, deploymentId: string): boolean {
  const trimmed = current.replace(/\/+$/, "");
  return trimmed.endsWith(`/releases/${deploymentId}`) || trimmed === `releases/${deploymentId}`;
}

export async function abortMountedReleaseHostWork(
  executor: CommandExecutor,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  requestDeployAbort(deploymentId);
  const hostRoot = mountedReleaseHostRoot(projectId);
  const name = mountedReleaseBuilderName(deploymentId);
  await executor.exec(`docker rm -f ${shellQuote(name)} >/dev/null 2>&1 || true`).catch(() => {});
  await executor.rm(`${hostRoot}/.incoming-${deploymentId}`).catch(() => {});
  await executor.rm(`${hostRoot}/.auth-${deploymentId}`).catch(() => {});
}

/** Restore the previous current pointer. Does not delete current into a hole. */
export async function revertReleaseCurrent(
  executor: CommandExecutor,
  hostRoot: string,
  previous: string | undefined,
): Promise<void> {
  if (!previous) return;
  await executor.exec(
    `ln -sfn ${shellQuote(previous)} ${shellQuote(`${hostRoot}/current.next`)} && ` +
      `mv -Tf ${shellQuote(`${hostRoot}/current.next`)} ${shellQuote(`${hostRoot}/current`)}`,
  );
}

export async function execUnlessCancelled(
  executor: CommandExecutor,
  signal: AbortSignal,
  deploymentId: string,
  command: string,
  opts?: { timeout?: number },
): Promise<string> {
  if (signal.aborted) throw cancelledError();
  await assertReleaseNotCancelled(deploymentId);
  return Promise.race([
    executor.exec(command, opts),
    new Promise<string>((_, reject) => {
      if (signal.aborted) {
        reject(cancelledError());
        return;
      }
      signal.addEventListener("abort", () => reject(cancelledError()), { once: true });
    }),
  ]);
}
