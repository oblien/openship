import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "@repo/core";
import { createProvisionLock, tryWithProvisionLock } from "./provision-lock";

const ownership = new AsyncLocalStorage<{
  deploymentId: string;
  active: boolean;
  recovering: boolean;
}>();

// Keep the existing Cloud key: rolling deployments must share the same fence.
export const deploymentExecutionLockKey = (deploymentId: string) =>
  `cloud:build-execution:${deploymentId}`;

export function runOutsideDeploymentExecutionOwnership<T>(work: () => T): T {
  return ownership.exit(work);
}

async function owned<T>(
  deploymentId: string,
  work: () => Promise<T>,
  recovering = false,
): Promise<T> {
  const state = { deploymentId, active: true, recovering };
  try {
    return await ownership.run(state, work);
  } finally {
    state.active = false;
  }
}

/** Hold through backups, runtime operations, cleanup and the final durable ack.
 * A delayed claimant must re-read cancellation after acquiring this fence. */
export async function withDeploymentExecutionOwnership<T>(
  deploymentId: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const inherited = ownership.getStore();
  if (inherited) {
    if (!inherited.active || inherited.recovering || inherited.deploymentId !== deploymentId)
      throw new AppError(
        "Deployment execution ownership cannot be inherited by this worker",
        409,
        "CLOUD_BUILD_EXECUTION_OWNERSHIP_CHANGED",
      );
    signal?.throwIfAborted();
    return work();
  }
  return createProvisionLock(deploymentExecutionLockKey(deploymentId)).run(async () => {
    signal?.throwIfAborted();
    return owned(deploymentId, work);
  }, signal);
}

/** Never wait behind a live worker, or treat a local registry miss as proof of
 * abandonment. The mutex and PostgreSQL lock cover other processes/replicas. */
export async function tryWithDeploymentExecutionOwnership<T>(
  deploymentId: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  if (ownership.getStore()?.active) return undefined;
  return tryWithProvisionLock(deploymentExecutionLockKey(deploymentId), () =>
    owned(deploymentId, work, true),
  );
}
