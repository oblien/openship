import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "@repo/core";
import { repos, type CloudBuildActivity, type CloudBuildActivityIdentity } from "@repo/db";
import { withManagedCommandTracking } from "@repo/adapters";
import { env } from "../config/env";
import { createProvisionLock, tryWithProvisionLock } from "./provision-lock";
import { cloudBuildActivityContext } from "./cloud-build-activity-context";
import { isCloudWorkspaceActivityHeld, withCloudWorkspaceActivity } from "./cloud-workspace-lock";
import { verifyCloudBuildWorkerStopped } from "./cloud-build-worker-recovery";

export type { CloudBuildActivityIdentity } from "@repo/db";

export type CloudBuildAdmissionDeferredReason =
  | "CLOUD_WORKSPACE_ACTIVITY_BUSY"
  | "CLOUD_WORKSPACE_BUSY"
  | "CLOUD_BUILD_PROJECT_BUSY"
  | "CLOUD_BUILD_HOST_NOT_READY"
  | "CLOUD_WORKSPACE_BUILD_CAPACITY";

/** Only emitted when shared activation was refused before work started.
 * Catch outside withCloudBuildActivity (after its project mutex unwinds), while
 * retaining outer execution ownership for the atomic unactivated-only deferral. */
export class CloudBuildAdmissionDeferredError extends AppError {
  constructor(
    public readonly reason: CloudBuildAdmissionDeferredReason,
    public readonly cause: AppError,
  ) {
    super(cause.message, 409, "CLOUD_BUILD_ADMISSION_DEFERRED");
    this.name = "CloudBuildAdmissionDeferredError";
  }
}

export interface CloudBuildActivityOptions {
  /** Verify daemon-owned workers stopped, in addition to tracked exec commands.
   * Defaults to the Cloud project BuildKit worker check. Runs under execution/
   * project ownership with managed command tracking active. */
  verifyQuiescence?: () => Promise<void>;
}

const executionOwnership = new AsyncLocalStorage<{
  deploymentId: string;
  active: boolean;
  recovering: boolean;
}>();

/** Detached workers must acquire their own activity even while the parent is live. */
export function runOutsideCloudBuildActivity<T>(work: () => T): T {
  return executionOwnership.exit(() => cloudBuildActivityContext.exit(work));
}

/** Global deployment identity prevents a changed destination acquiring another owner. */
export const cloudBuildActivityLockKey = (deploymentId: string) =>
  `cloud:build-execution:${deploymentId}`;

async function inExecutionOwnership<T>(
  deploymentId: string,
  work: () => Promise<T>,
  recovering = false,
): Promise<T> {
  const state = { deploymentId, active: true, recovering };
  try {
    return await executionOwnership.run(state, work);
  } finally {
    state.active = false;
  }
}

/** Wrap the ENTIRE worker, including backups and final lease acknowledgement.
 * The pipeline must recheck durable cancellation immediately after admission,
 * before backups: recovery may have won before this delayed worker acquired it.
 * Same-execution nested shared admission reuses ownership without another mutex. */
export async function withCloudBuildExecutionOwnership<T>(
  deploymentId: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const inherited = executionOwnership.getStore();
  if (inherited) {
    if (!inherited.active || inherited.recovering || inherited.deploymentId !== deploymentId)
      throw new AppError(
        "Cloud build execution ownership cannot be inherited by this worker",
        409,
        "CLOUD_BUILD_EXECUTION_OWNERSHIP_CHANGED",
      );
    signal?.throwIfAborted();
    return work();
  }
  return createProvisionLock(cloudBuildActivityLockKey(deploymentId)).run(async () => {
    signal?.throwIfAborted();
    return inExecutionOwnership(deploymentId, work);
  }, signal);
}

function assertFreshContext() {
  if (cloudBuildActivityContext.getStore())
    throw new AppError(
      "Cloud build activities cannot be nested",
      409,
      "CLOUD_BUILD_ACTIVITY_NESTED",
    );
}

async function localWorkspace(input: CloudBuildActivityIdentity) {
  const workspace = await repos.cloudWorkspace.findById(input.workspaceId);
  if (!workspace || workspace.organizationId !== input.organizationId)
    throw new AppError("Managed server not found", 404, "CLOUD_WORKSPACE_NOT_FOUND");
  return env.CLOUD_MODE && !workspace.remote;
}

async function tracked<T>(
  row: CloudBuildActivity,
  work: () => Promise<T>,
  options: CloudBuildActivityOptions = {},
) {
  if (!row.ownerToken) throw new Error("Cloud build activity has no execution owner");
  const ownerToken = row.ownerToken;
  const identity: CloudBuildActivityIdentity = row;
  const state = {
    identity,
    ownerToken,
    active: true,
    verifyQuiescence: options.verifyQuiescence ?? verifyCloudBuildWorkerStopped,
  };
  const check = () => {
    if (!state.active)
      throw new AppError(
        "The Cloud build activity has finished",
        409,
        "CLOUD_BUILD_ACTIVITY_CHANGED",
      );
  };
  try {
    return await cloudBuildActivityContext.run(state, () =>
      withManagedCommandTracking(
        {
          async record(command) {
            check();
            await repos.cloudBuildActivity.recordCommand(identity, ownerToken, command);
          },
          async complete(marker) {
            check();
            await repos.cloudBuildActivity.completeCommand(identity, ownerToken, marker);
          },
        },
        work,
      ),
    );
  } finally {
    state.active = false;
  }
}

/** Shared admission for provisioned Cloud-local hosts. The caller must await all
 * host work/cleanup and retain project and short host mutation locks. This is
 * deliberately not reentrant; a duplicate deployment requires explicit recovery. */
export async function withCloudBuildActivity<T>(
  input: CloudBuildActivityIdentity,
  work: () => Promise<T>,
  signal?: AbortSignal,
  options: CloudBuildActivityOptions = {},
): Promise<T> {
  assertFreshContext();
  if (!(await localWorkspace(input)))
    return withCloudWorkspaceActivity(input.workspaceId, work, signal, {
      scope: `project:${input.projectId}`,
    });
  if (isCloudWorkspaceActivityHeld(input.workspaceId))
    throw new AppError(
      "Release exclusive activity before shared build admission",
      409,
      "CLOUD_BUILD_ACTIVITY_NESTED",
    );
  return withCloudBuildExecutionOwnership(
    input.deploymentId,
    () =>
      createProvisionLock(`cloud:build-project:${input.projectId}`).run(async () => {
        signal?.throwIfAborted();
        const ownerToken = randomUUID();
        let row: CloudBuildActivity;
        try {
          row = await repos.cloudBuildActivity.claim(input, ownerToken);
        } catch (error) {
          if (error instanceof AppError) {
            switch (error.code) {
              case "CLOUD_WORKSPACE_ACTIVITY_BUSY":
              case "CLOUD_WORKSPACE_BUSY":
              case "CLOUD_BUILD_PROJECT_BUSY":
              case "CLOUD_BUILD_HOST_NOT_READY":
              case "CLOUD_WORKSPACE_BUILD_CAPACITY":
                throw new CloudBuildAdmissionDeferredError(error.code, error);
            }
          }
          throw error;
        }
        let verified = false;
        try {
          return await tracked(
            row,
            async () => {
              try {
                signal?.throwIfAborted();
                return await work();
              } finally {
                await (options.verifyQuiescence ?? verifyCloudBuildWorkerStopped)();
                verified = true;
              }
            },
            options,
          );
        } finally {
          // Refuses release if transport exit is unresolved. The durable activity
          // stays reserved even after this process gives up its advisory lock.
          if (verified) await repos.cloudBuildActivity.finish(input, ownerToken);
        }
      }, signal),
    signal,
  );
}

/** Call after all source-build tasks and their transport acknowledgements finish.
 * Later deployment commands may still be recorded; lifecycle admission stays held.
 * Exclusive linked/self-hosted execution has no shared capacity row to release. */
export async function releaseCloudBuildSlot(): Promise<void> {
  const state = cloudBuildActivityContext.getStore();
  if (!state) return;
  if (!state.active)
    throw new AppError(
      "The Cloud build activity has finished",
      409,
      "CLOUD_BUILD_ACTIVITY_CHANGED",
    );
  await (state.verifyQuiescence ?? verifyCloudBuildWorkerStopped)();
  await repos.cloudBuildActivity.releaseSlot(state.identity, state.ownerToken);
}

/** False means live, absent, or not Cloud-local. True means this exact execution
 * is settled. Never scans or stops a sibling execution's commands. Cleanup must
 * recheck deployment state and protect live releases before mutating the host.
 * For an unactivated reservation cleanup is DATABASE-ONLY: no host admission was
 * acquired. Its separate backup/provisioning operations keep their own fences. */
export async function recoverCloudBuildActivity(
  input: CloudBuildActivityIdentity,
  cleanup: (state: { activated: boolean }) => Promise<void>,
  options: CloudBuildActivityOptions & {
    /** Settle durable deployment state after host work already finished. Runs
     * under the same execution/project locks, without reopening the worker. */
    onFinished?: () => Promise<void>;
  } = {},
): Promise<boolean> {
  assertFreshContext();
  if (!(await localWorkspace(input))) return false;
  if (isCloudWorkspaceActivityHeld(input.workspaceId))
    throw new AppError(
      "Release exclusive activity before build recovery",
      409,
      "CLOUD_BUILD_ACTIVITY_NESTED",
    );
  if (executionOwnership.getStore()?.active) return false;
  return (
    (await tryWithProvisionLock(cloudBuildActivityLockKey(input.deploymentId), () =>
      inExecutionOwnership(
        input.deploymentId,
        () =>
          tryWithProvisionLock(`cloud:build-project:${input.projectId}`, async () => {
            const previous = await repos.cloudBuildActivity.find(input);
            if (!previous) return false;
            if (previous.finishedAt) {
              await options.onFinished?.();
              return true;
            }
            if (!previous.ownerToken) {
              if (previous.commands.length)
                throw new AppError(
                  "An unactivated build has unresolved commands",
                  503,
                  "CLOUD_COMMAND_EXIT_UNCONFIRMED",
                );
              await cleanup({ activated: false });
              if (await repos.cloudBuildActivity.cancelReservation(input)) return true;
              // A callback may atomically cancel the reservation with its DB state write.
              return !!(await repos.cloudBuildActivity.find(input))?.finishedAt;
            }
            const ownerToken = randomUUID();
            const row = await repos.cloudBuildActivity.takeRecoveryOwnership(input, ownerToken);
            if (!row) return false;
            // Do not route recovery through a new provider binding after reassignment.
            const binding = await repos.cloudDockerWorkspace.find(
              { ownerWorkspaceId: input.workspaceId },
              input.organizationId,
            );
            if (binding?.workspaceId !== row.providerWorkspaceId)
              throw new AppError(
                "The build's Cloud server binding changed",
                409,
                "CLOUD_SERVER_IDENTITY_MISMATCH",
              );
            await tracked(
              row,
              async () => {
                if (row.commands.length) {
                  const { openCloudWorkspaceExecutor } = await import("./cloud-workspace-host");
                  const executor = await openCloudWorkspaceExecutor(
                    input.organizationId,
                    input.workspaceId,
                  );
                  try {
                    for (const command of row.commands) {
                      await executor.recoverCommand(command);
                      await repos.cloudBuildActivity.completeCommand(
                        input,
                        ownerToken,
                        command.marker,
                      );
                    }
                  } finally {
                    await executor.dispose();
                  }
                }
                await (options.verifyQuiescence ?? verifyCloudBuildWorkerStopped)();
                await cleanup({ activated: true });
              },
              options,
            );
            // A cleanup failure retains the activity even if no command remains.
            await repos.cloudBuildActivity.finish(input, ownerToken);
            return true;
          }),
        true,
      ),
    )) === true
  );
}
