import { repos, type Deployment } from "@repo/db";
import { AppError, NotFoundError, ValidationError, withTimeout, type StackRole } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { ProjectRuntimeLogsInput, ProjectRuntimeRoles, RuntimeRole } from "@repo/contracts";
import { findActiveDeployment } from "../../lib/active-deployment";
import { assertResourceInOrg } from "../../lib/resource-access";
import { withDeploymentRuntime } from "../../lib/deployment-runtime";
import { planRoleReplicas } from "../deployments/role-rollout";
import { liveContainerStatus } from "../services/live-state";

type RoleDeployment = Pick<Deployment, "id" | "meta" | "roleContainers">;

/** A request may select a recorded role, never supply a Docker container ID. */
export function roleLogContainerId(
  dep: RoleDeployment,
  input?: ProjectRuntimeLogsInput,
): string | null {
  if (input?.deploymentId && input.deploymentId !== dep.id) {
    throw new AppError(
      "The active deployment changed. Select the role again.",
      409,
      "PROJECT_LOG_TARGET_STALE",
    );
  }
  if (!input?.role) {
    if (input?.replica !== undefined) throw new ValidationError("Select a role before a replica.");
    return null;
  }
  const ref = dep.roleContainers?.find(
    (candidate) => candidate.role === input.role && candidate.replica === (input.replica ?? 1),
  );
  if (!ref?.containerId) throw new NotFoundError("Role replica", input.role);
  return ref.containerId;
}

function roleInventory(dep: RoleDeployment): RuntimeRole[] {
  const saved = (dep.meta as { roles?: StackRole[] } | null)?.roles;
  const definitions = Array.isArray(saved) ? saved : [];
  const plan = planRoleReplicas(definitions);
  const planned = [...plan.scalable, ...plan.singletons];
  const byName = new Map<string, RuntimeRole>();
  for (const definition of definitions) {
    const replicas = planned.filter((entry) => entry.role.name === definition.name);
    byName.set(definition.name, {
      name: definition.name,
      kind: definition.kind,
      replicas: replicas.length,
      containers: replicas.map(({ replica }) => ({
        replica,
        containerId: null,
        status: "missing",
        restartCount: null,
      })),
    });
  }
  for (const ref of dep.roleContainers ?? []) {
    let role = byName.get(ref.role);
    if (!role) {
      role = { name: ref.role, kind: null, replicas: 0, containers: [] };
      byName.set(ref.role, role);
    }
    const replica = role.containers.find((entry) => entry.replica === ref.replica);
    const tracked = {
      replica: ref.replica,
      containerId: ref.containerId,
      status: "unknown" as const,
      restartCount: null,
    };
    if (replica) Object.assign(replica, tracked);
    else role.containers.push(tracked);
    role.replicas = Math.max(role.replicas, role.containers.length);
  }
  return [...byName.values()];
}

/** Read only the active release. No provisioning, health commands, or lifecycle writes. */
export async function getRuntimeRoles(
  projectId: string,
  organizationId: string,
): Promise<ProjectRuntimeRoles> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  const dep = await findActiveDeployment(project);
  if (!dep) return { deploymentId: null, roles: [], error: null };
  const roles = roleInventory(dep);
  const replicas = roles.flatMap((role) => role.containers).filter((entry) => entry.containerId);
  if (replicas.length === 0) return { deploymentId: dep.id, roles, error: null };
  const deadline = Date.now() + 10_000;
  try {
    await withTimeout(
      withDeploymentRuntime(dep, async (runtime) => {
        if (!runtime.supports("stabilityProbe") || !runtime.sampleStability) {
          throw new Error("This runtime cannot report role status.");
        }
        // Keep inventory polls bounded even when a release has many replicas.
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, replicas.length) }, async () => {
            while (next < replicas.length && Date.now() < deadline) {
              const replica = replicas[next++];
              try {
                const sample = await withTimeout(
                  runtime.sampleStability!(replica.containerId!),
                  Math.max(1, deadline - Date.now()),
                  "Role status check timed out",
                );
                replica.status =
                  sample.state === "missing" || sample.state === "unknown"
                    ? sample.state
                    : liveContainerStatus({
                        state: sample.state,
                        status:
                          sample.health === "starting"
                            ? "(health: starting)"
                            : sample.health
                              ? `(${sample.health})`
                              : "",
                      });
                replica.restartCount = sample.state === "missing" ? null : sample.restartCount;
              } catch (error) {
                reportCaughtError(error, "platform/engine/modules/projects/project-roles");
              }
            }
          }),
        );
      }),
      10_000,
      "Role status check timed out",
    );
    return {
      deploymentId: dep.id,
      roles,
      error: replicas.some((replica) => replica.status === "unknown")
        ? "Some role statuses could not be checked. Retry when the server is reachable."
        : null,
    };
  } catch (error) {
    reportCaughtError(error, "platform/engine/modules/projects/project-roles");
    return {
      deploymentId: dep.id,
      roles: roleInventory(dep),
      error: "Role status could not be checked. Retry when the server is reachable.",
    };
  }
}
