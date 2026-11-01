import { isDeepStrictEqual } from "node:util";
import { AppError, type RoleContainerRef, type StackRole } from "@repo/core";
import { DockerRuntime, type BuildLogger, type DeployConfig } from "@repo/adapters";
import { repos, type Deployment, type Project } from "@repo/db";
import type { DeploymentConfigSnapshot } from "./build.service";
import { withProjectRuntimeTransition } from "../../lib/project-runtime-lock";
import {
  beginRoleHandover,
  assertRoleInventorySettled,
  recoverProjectRoleHandovers,
  pendingRoleHandover,
} from "./role-handover";
import { rolloutRoles, planRoleReplicas } from "./role-rollout";
import { runtimeRoleRolloutDeps } from "./role-runtime";
import { resolveReadinessGate } from "./readiness-gate";
import { inspectRoleConfigurationImage } from "../projects/role-configuration.service";
import {
  throwIfDeploymentCancelled,
  deploymentCancellationKeepsProvisioned,
} from "./deployment-cancellation";

/** Replicas change cardinality, not the runtime definition of an existing replica. */
export function reusableRoleReplicas(
  previous: Deployment,
  roles: readonly StackRole[],
): RoleContainerRef[] {
  const before = (previous.meta as DeploymentConfigSnapshot | null)?.roles ?? [];
  const after = planRoleReplicas(roles);
  const plan = [...after.scalable, ...after.singletons];
  return (previous.roleContainers ?? [])
    .filter((ref) => {
      const old = before.find((role) => role.name === ref.role);
      const next = plan.find(
        (entry) => entry.role.name === ref.role && entry.replica === ref.replica,
      )?.role;
      if (!old || !next) return false;
      const { replicas: _oldCount, ...oldDefinition } = old;
      const { replicas: _newCount, ...newDefinition } = next;
      return isDeepStrictEqual(oldDefinition, newDefinition);
    })
    .map((ref) => ({ ...ref, ownerDeploymentId: ref.ownerDeploymentId ?? previous.id }));
}

/** The normal worker calls this after resolving the immutable artifact. No web,
 * port, release-command or routing operation belongs to this configuration change. */
export async function runRoleConfigurationRollout(input: {
  project: Project;
  dep: Deployment;
  runtime: DockerRuntime;
  config: DeployConfig;
  logger: BuildLogger;
  signal?: AbortSignal;
  beforeStart: (containerId: string) => Promise<void>;
  publish: (containerId: string, warning?: string) => Promise<void>;
}) {
  const { project, dep, runtime, config, logger, signal } = input;
  const snapshot = dep.meta as DeploymentConfigSnapshot;
  const intent = snapshot.roleConfiguration!;
  return withProjectRuntimeTransition(
    project.id,
    async () => {
      throwIfDeploymentCancelled(signal);
      const live = await repos.project.findById(project.id);
      if (
        !live ||
        live.deletionInProgress ||
        live.disabledAt ||
        live.activeDeploymentId !== intent.sourceDeploymentId
      )
        throw new AppError(
          "The active release changed. Reload the role settings.",
          409,
          "ROLE_CONFIGURATION_CHANGED",
        );
      await recoverProjectRoleHandovers(project.id);
      const previous = await repos.deployment.findById(intent.sourceDeploymentId);
      if (
        !previous ||
        previous.projectId !== project.id ||
        previous.organizationId !== dep.organizationId ||
        previous.containerId !== intent.webContainerId
      )
        throw new AppError(
          "The configuration's source release changed.",
          409,
          "ROLE_CONFIGURATION_CHANGED",
        );
      const identity = await inspectRoleConfigurationImage(runtime, live, previous);
      if (
        identity.imageId !== intent.imageId ||
        config.imageRef !== intent.imageId ||
        identity.ownerDeploymentId !== intent.webOwnerDeploymentId
      )
        throw new AppError(
          "The active image changed. Reload the role settings.",
          409,
          "ROLE_CONFIGURATION_CHANGED",
        );
      await assertRoleInventorySettled(runtime, project.id, previous.roleContainers ?? []);
      config.previousContainerId = intent.webContainerId;
      await runtime.prepareDeploymentVolumes(config);
      const reuse = reusableRoleReplicas(previous, snapshot.roles ?? []);
      for (const ref of reuse) {
        if (
          !(await runtime.findOwnedDeploymentContainer(ref.containerId, {
            projectId: project.id,
            deploymentId: ref.ownerDeploymentId!,
            role: ref.role,
          }))
        )
          throw new AppError(
            "An unchanged role replica is missing. Redeploy the app before applying these settings.",
            409,
            "ROLE_CONFIGURATION_UNAVAILABLE",
          );
      }
      const journal = await beginRoleHandover({
        dep,
        previous,
        config,
        roles: snapshot.roles,
        reuse,
        preserveWeb: {
          containerId: intent.webContainerId,
          ownerDeploymentId: intent.webOwnerDeploymentId,
        },
      });
      let rollout: Awaited<ReturnType<typeof rolloutRoles>> | undefined;
      let committing = false;
      try {
        logger.log(
          `Reusing the active image; preserving web and ${reuse.length} unchanged role replica(s).\n`,
        );
        rollout = await rolloutRoles(
          runtimeRoleRolloutDeps({
            roles: snapshot.roles,
            previousRoles: (previous.meta as DeploymentConfigSnapshot).roles,
            previous: previous.roleContainers,
            reuse,
            runtime,
            previousRuntime: runtime,
            config,
            logger,
            beforeStart: input.beforeStart,
            stabilizationWindowMs: resolveReadinessGate(live.readiness).stabilization.windowMs,
            signal,
            recordCreated: journal.recordCreated,
            recordStopIntent: journal.recordStopIntent,
            keepProvisionedOnCancel: () => deploymentCancellationKeepsProvisioned(signal),
          }),
        );
        throwIfDeploymentCancelled(signal);
        await journal.recordWeb(intent.webContainerId);
        await journal.committing();
        committing = true;
        const warning = await rollout.commit();
        await input.publish(intent.webContainerId, warning ?? undefined);
        if (!warning && (await repos.project.findById(project.id))?.activeDeploymentId === dep.id)
          await journal.complete();
      } catch (error) {
        if (!committing) {
          if (deploymentCancellationKeepsProvisioned(signal)) await journal.kept();
          else await rollout?.abort();
        }
        throw error;
      } finally {
        const current = await repos.deployment.findById(dep.id);
        if (
          current &&
          pendingRoleHandover(current) &&
          !deploymentCancellationKeepsProvisioned(signal)
        ) {
          // Strict cleanup failure stays durable and visible for the existing reconciler.
          await recoverProjectRoleHandovers(project.id, { executingDeploymentId: dep.id });
        }
      }
    },
    signal,
  );
}
