/** Per-project execution lease. Cancel must not clear it while a worker is running. */
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
const workers = new Set<string>();

export function beginDeployRun(deploymentId: string): AbortSignal {
  workers.add(deploymentId);
  const existing = runs.get(deploymentId);
  if (existing) return existing.signal;
  const abort = new AbortController();
  runs.set(deploymentId, abort);
  return abort.signal;
}

export function requestDeployAbort(deploymentId: string): boolean {
  const existing = runs.get(deploymentId);
  if (existing) {
    existing.abort();
    return workers.has(deploymentId);
  }
  const abort = new AbortController();
  abort.abort();
  runs.set(deploymentId, abort);
  return false;
}

export function endDeployRun(deploymentId: string): void {
  workers.delete(deploymentId);
  runs.delete(deploymentId);
}

export function hasDeployRun(deploymentId: string): boolean {
  return workers.has(deploymentId);
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

export async function revertIfIncompleteActivation(
  executor: CommandExecutor,
  projectId: string,
  dep: Pick<Deployment, "id" | "status" | "meta">,
): Promise<void> {
  if (dep.status === "ready") return;
  const hostRoot = mountedReleaseHostRoot(projectId);
  const current = (
    await executor
      .exec(`readlink ${shellQuote(`${hostRoot}/current`)} 2>/dev/null || true`)
      .catch(() => "")
  ).trim();
  if (!currentPointsAtDeployment(current, dep.id)) return;
  await revertReleaseCurrent(executor, hostRoot, releaseLaneMeta(dep).releasePreviousCurrent);
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
  const running = executor.exec(command, opts);
  running.catch(() => {});
  return Promise.race([
    running,
    new Promise<string>((_, reject) => {
      if (signal.aborted) {
        reject(cancelledError());
        return;
      }
      signal.addEventListener("abort", () => reject(cancelledError()), { once: true });
    }),
  ]);
}

/** Wait for the host command, then refuse if the row was cancelled mid-flight. */
export async function execAndConfirm(
  executor: CommandExecutor,
  deploymentId: string,
  command: string,
  opts?: { timeout?: number },
): Promise<string> {
  await assertReleaseNotCancelled(deploymentId);
  const result = await executor.exec(command, opts);
  await assertReleaseNotCancelled(deploymentId);
  return result;
}
