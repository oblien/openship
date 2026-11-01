import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionsWorker, probeActionCapabilities } from "@repo/adapters";
import { AppError, actionContainerPlatform, actionRunnerMismatch } from "@repo/core";
import type { ActionJob, ActionRunner } from "@repo/db";
import { acquireServerExecution } from "../../lib/server-execution";

export type ActionWorkerAllocation = Pick<
  ActionJob,
  | "id"
  | "organizationId"
  | "spec"
  | "directory"
  | "workerBinary"
  | "workerStartedAt"
  | "providerRequestedAt"
  | "providerWorkspaceId"
>;
export type UpdateActionAllocation = (
  patch: Partial<
    Pick<
      ActionWorkerAllocation,
      | "directory"
      | "workerBinary"
      | "workerStartedAt"
      | "providerRequestedAt"
      | "providerWorkspaceId"
    >
  >,
) => Promise<ActionWorkerAllocation | undefined>;

export function actionWorkerAssets(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OPENSHIP_ACTIONS_RUNNER_DIR,
    join(here, "assets/actions-runner"),
    join(here, "../assets/actions-runner"),
    join(here, "../server/assets/actions-runner"),
    join(here, "../../../../../actions-runner/dist"),
    join(process.cwd(), "packages/actions-runner/dist"),
    join(process.cwd(), "../../packages/actions-runner/dist"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(join(p, "manifest.json")));
  if (!found)
    throw new AppError(
      "The Actions runner assets are missing. Build or install the Actions runner before starting workflows.",
      503,
      "ACTIONS_RUNNER_ASSET_MISSING",
    );
  return found;
}

/** Both controllers use this single destination path. Allocation persistence is
 * supplied by the caller; neither controller gets a local execution fallback. */
export async function openActionWorker(
  allocation: ActionWorkerAllocation,
  runner: ActionRunner,
  owner: string,
  update: UpdateActionAllocation,
) {
  if (allocation.organizationId !== runner.organizationId)
    throw new AppError(
      "Actions destination is not owned by this organization",
      403,
      "ACTIONS_RUNNER_FORBIDDEN",
    );
  if (runner.cloudPoolId)
    return (await import("./cloud-runner")).openCloudActionWorker(
      allocation,
      allocation,
      runner,
      owner,
      actionWorkerAssets(),
      update,
    );
  if (!runner.serverId)
    throw new AppError(
      "Actions runner has no execution destination",
      409,
      "ACTIONS_RUNNER_UNAVAILABLE",
    );
  const connection = await acquireServerExecution(allocation.organizationId, runner.serverId);
  try {
    const worker = new ActionsWorker(connection.executor, actionWorkerAssets());
    if (allocation.workerBinary && allocation.directory && allocation.workerStartedAt)
      return {
        worker,
        binary: allocation.workerBinary,
        directory: allocation.directory,
        release: connection.release,
      };
    const capabilities = await connection.run(probeActionCapabilities);
    const mismatch = actionRunnerMismatch(capabilities, runner.config, allocation.spec!);
    if (mismatch) throw new AppError(mismatch, 409, "ACTIONS_RUNNER_UNSUPPORTED");
    const prepared = await worker.prepare(capabilities);
    return {
      worker,
      binary: prepared.binary,
      capabilities,
      containerPlatform: actionContainerPlatform(capabilities, runner.config, allocation.spec!),
      directory: `${prepared.root}/jobs/${allocation.id}`,
      release: connection.release,
    };
  } catch (error) {
    await connection.release();
    throw error;
  }
}

export async function removeActionWorker(
  allocation: ActionWorkerAllocation,
  runner: ActionRunner,
  owner: string,
  update: UpdateActionAllocation,
) {
  if (runner.organizationId !== allocation.organizationId)
    throw new Error("Actions destination ownership changed");
  if (runner.cloudPoolId)
    return (await import("./cloud-runner")).removeCloudActionWorker(
      allocation,
      allocation,
      runner,
      owner,
      update,
    );
  if (runner.serverId && allocation.workerBinary && allocation.directory) {
    const connection = await acquireServerExecution(allocation.organizationId, runner.serverId);
    try {
      await new ActionsWorker(connection.executor, actionWorkerAssets()).clean(
        allocation.workerBinary,
        allocation.directory,
      );
    } finally {
      await connection.release();
    }
  }
  return true;
}
