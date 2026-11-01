import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { currentManagedCommandTracking, removeProjectBuildKitWorker } from "@repo/adapters";
import { cloudBuildActivityContext } from "./cloud-build-activity-context";

/** A quiescence hook for Cloud build activity/slot completion and recovery.
 * The activity wrapper holds both execution ownership and the project build
 * mutex; caller-supplied project IDs must never choose the worker to remove. */
export async function verifyCloudBuildWorkerStopped(): Promise<void> {
  const state = cloudBuildActivityContext.getStore();
  if (!state?.active)
    throw new AppError(
      "Build worker recovery requires an active Cloud build activity",
      409,
      "CLOUD_BUILD_ACTIVITY_CHANGED",
    );
  // Archive/HTTP consumers can finish before the bridge's durable completion
  // callback. Drain those acknowledgements before interpreting the command ledger.
  await currentManagedCommandTracking()?.flush();
  const { identity } = state;
  const [row, binding] = await Promise.all([
    repos.cloudBuildActivity.find(identity),
    repos.cloudDockerWorkspace.find(
      { ownerWorkspaceId: identity.workspaceId },
      identity.organizationId,
    ),
  ]);
  if (
    !row ||
    row.ownerToken !== state.ownerToken ||
    row.finishedAt ||
    binding?.workspaceId !== row.providerWorkspaceId
  )
    throw new AppError(
      "The build's Cloud server binding or execution owner changed",
      409,
      "CLOUD_SERVER_IDENTITY_MISMATCH",
    );
  if (row.commands.length)
    throw new AppError(
      "Recover the build commands before removing their worker",
      503,
      "CLOUD_COMMAND_EXIT_UNCONFIRMED",
    );
  const { openCloudWorkspaceExecutor } = await import("./cloud-workspace-host");
  const executor = await openCloudWorkspaceExecutor(identity.organizationId, identity.workspaceId);
  try {
    await removeProjectBuildKitWorker(executor, identity.projectId);
  } finally {
    await executor.dispose();
  }
}
