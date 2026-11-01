import { AppError, type StackRole } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import { DockerRuntime, OPENSHIP_LABEL, type DeployConfig } from "@repo/adapters";
import { repos, type Deployment, type Project } from "@repo/db";
import { withProjectRuntimeTransition } from "../../lib/project-runtime-lock";
import { withDeploymentRuntime } from "../../lib/deployment-runtime";
import { planRoleReplicas, type RoleContainerRef } from "./role-rollout";

interface RoleHandover extends Record<string, unknown> {
  version: 1 | 2;
  revision: number;
  phase: "preparing" | "committing" | "kept" | "complete";
  previousDeploymentId: string | null;
  candidates: Array<{ role: string; replica: number; name: string }>;
  stopped: RoleContainerRef[];
  webName: string;
  webContainerId: string | null;
  stopPreviousWeb: boolean;
  preserveWeb?: { containerId: string; ownerDeploymentId: string };
  reused?: RoleContainerRef[];
}

export function pendingRoleHandover(dep: Pick<Deployment, "roleHandover">): boolean {
  const value = dep.roleHandover;
  return !!value && value.phase !== "complete";
}

/** Old releases have no journal. Unknown role processes are evidence to stop
 * admission, never permission to delete a container by its labels alone. */
export async function assertRoleInventorySettled(
  runtime: DockerRuntime,
  projectId: string,
  active: readonly RoleContainerRef[],
): Promise<void> {
  const known = new Set(active.map((ref) => ref.containerId));
  const unknown = (await runtime.listAllContainers()).filter(
    (container) =>
      container.labels?.[OPENSHIP_LABEL.project] === projectId &&
      !!container.labels?.[OPENSHIP_LABEL.role] &&
      !known.has(container.id) &&
      !["exited", "dead"].includes(container.state),
  );
  if (unknown.length) {
    throw new AppError(
      `Earlier role containers still need review before another rollout: ${unknown.map((container) => container.id.slice(0, 12)).join(", ")}. Stop or remove those containers after checking which release should run.`,
      409,
      "ROLE_HANDOVER_RECOVERY_PENDING",
    );
  }
}

function readHandover(dep: Deployment): RoleHandover {
  const value = dep.roleHandover as RoleHandover | null;
  if (
    !value ||
    ![1, 2].includes(value.version) ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    !["preparing", "committing", "kept", "complete"].includes(value.phase) ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.stopped) ||
    (value.preserveWeb !== undefined &&
      (!value.preserveWeb ||
        typeof value.preserveWeb.containerId !== "string" ||
        typeof value.preserveWeb.ownerDeploymentId !== "string")) ||
    (value.reused !== undefined &&
      (!Array.isArray(value.reused) ||
        !value.reused.every(
          (ref) =>
            ref &&
            typeof ref.containerId === "string" &&
            typeof ref.role === "string" &&
            Number.isInteger(ref.replica) &&
            ref.replica > 0 &&
            typeof ref.ownerDeploymentId === "string",
        ))) ||
    typeof value.webName !== "string" ||
    !(value.previousDeploymentId === null || typeof value.previousDeploymentId === "string") ||
    !(value.webContainerId === null || typeof value.webContainerId === "string") ||
    typeof value.stopPreviousWeb !== "boolean" ||
    !value.candidates.every(
      (ref) =>
        ref &&
        typeof ref.name === "string" &&
        typeof ref.role === "string" &&
        Number.isInteger(ref.replica) &&
        ref.replica > 0,
    ) ||
    !value.stopped.every(
      (ref) =>
        ref &&
        typeof ref.containerId === "string" &&
        typeof ref.role === "string" &&
        Number.isInteger(ref.replica) &&
        ref.replica > 0,
    )
  ) {
    throw new AppError(
      "Role handover records could not be verified. Recovery remains pending.",
      409,
      "ROLE_HANDOVER_RECOVERY_PENDING",
    );
  }
  return value;
}

async function writeHandover(
  dep: Deployment,
  value: RoleHandover,
  roleContainers?: RoleContainerRef[],
) {
  const expectedRevision = dep.roleHandover ? readHandover(dep).revision : null;
  const next = { ...value, revision: (expectedRevision ?? 0) + 1 };
  await repos.deployment.setRoleHandover({
    id: dep.id,
    projectId: dep.projectId,
    organizationId: dep.organizationId,
    value: next,
    roleContainers,
    committing: value.phase === "committing",
    expectedRevision,
  });
  dep.roleHandover = next;
  if (roleContainers) dep.roleContainers = roleContainers;
  return next;
}

/** Intent precedes Docker creation; the callback records the ID before start. */
export async function beginRoleHandover(input: {
  dep: Deployment;
  previous: Deployment | null | undefined;
  config: DeployConfig;
  roles?: readonly StackRole[];
  reuse?: RoleContainerRef[];
  preserveWeb?: { containerId: string; ownerDeploymentId: string };
}) {
  const { dep, previous, config } = input;
  const plan = planRoleReplicas(input.roles);
  let value: RoleHandover = {
    version: 2,
    revision: 0,
    phase: "preparing",
    previousDeploymentId: previous?.id ?? null,
    ...(input.preserveWeb ? { preserveWeb: input.preserveWeb } : {}),
    reused: input.reuse ?? [],
    candidates: [...plan.scalable, ...plan.singletons]
      .filter(
        (entry) =>
          !input.reuse?.some(
            (ref) => ref.role === entry.role.name && ref.replica === entry.replica,
          ),
      )
      .map(({ role, replica }) => ({
        role: role.name,
        replica,
        name: DockerRuntime.deploymentContainerName(config, { name: role.name, replica }),
      })),
    stopped: [],
    webName: DockerRuntime.deploymentContainerName(config),
    webContainerId: null,
    stopPreviousWeb: false,
  };
  value = await writeHandover(dep, value, input.reuse ?? []);
  const save = async (patch: Partial<RoleHandover>, roles?: RoleContainerRef[]) => {
    const next = { ...value, ...patch };
    value = await writeHandover(dep, next, roles);
  };
  return {
    recordCreated: (ref: RoleContainerRef) => save({}, [...(dep.roleContainers ?? []), ref]),
    recordStopIntent: (ref: RoleContainerRef) => save({ stopped: [...value.stopped, ref] }),
    recordWeb: (containerId: string) => save({ webContainerId: containerId }),
    stopPreviousWeb: () => save({ stopPreviousWeb: true }),
    committing: () =>
      value.phase === "committing" ? Promise.resolve() : save({ phase: "committing" }),
    kept: () => save({ phase: "kept" }),
    complete: () => save({ phase: "complete" }),
  };
}

/** Called only after execution has stopped, or by self-hosted boot recovery.
 * Exact journal references plus Docker labels replace guesses from listing all
 * containers. Every destructive operation must finish before a predecessor can
 * restart; an unreachable host leaves the journal pending for the next retry. */
async function recoverHandover(dep: Deployment, project: Project, discard = false): Promise<void> {
  const value = readHandover(dep);
  const reusedIds = new Set((value.reused ?? []).map((ref) => ref.containerId));
  if (value.phase === "complete") return;
  const keep = (dep.meta as { cancellation?: { keepProvisioned?: boolean } } | null)?.cancellation
    ?.keepProvisioned;
  if (!discard && keep && value.phase === "preparing") {
    // Cancellation intent is durable before the controller is notified. Honor
    // it even if that controller died before recording the kept phase.
    await writeHandover(dep, { ...value, phase: "kept" });
    throw new AppError(
      "This deployment kept its role containers. Delete the cancelled deployment to discard them before another rollout.",
      409,
      "ROLE_HANDOVER_RECOVERY_PENDING",
    );
  }
  if (value.phase === "kept") {
    throw new AppError(
      "This deployment kept its role containers. Keep or delete that deployment before starting another role handover.",
      409,
      "ROLE_HANDOVER_RECOVERY_PENDING",
    );
  }
  const previous = value.previousDeploymentId
    ? ((await repos.deployment.findById(value.previousDeploymentId)) ?? null)
    : null;
  if (value.previousDeploymentId && !previous) {
    throw new AppError(
      "The previous role release is missing; recovery remains pending",
      409,
      "ROLE_HANDOVER_RECOVERY_PENDING",
    );
  }
  if (
    previous &&
    (previous.projectId !== project.id || previous.organizationId !== project.organizationId)
  ) {
    throw new AppError(
      "The previous role release does not belong to this project",
      409,
      "ROLE_HANDOVER_RECOVERY_PENDING",
    );
  }
  await withDeploymentRuntime(dep, async (runtime) => {
    if (!(runtime instanceof DockerRuntime) || !runtime.supports("roles")) {
      throw new AppError(
        "This runtime cannot recover a role handover",
        409,
        "ROLE_HANDOVER_RECOVERY_PENDING",
      );
    }
    const owner = { projectId: project.id, deploymentId: dep.id };
    if (value.phase === "preparing") {
      // Remove candidates by their pre-recorded names, including a create whose
      // response was lost before its container ID could be saved.
      for (const ref of value.candidates) {
        const id = await runtime.findOwnedDeploymentContainer(ref.name, {
          ...owner,
          role: ref.role,
        });
        if (id) await runtime.destroy(id);
      }
      if (!value.preserveWeb) {
        const web = await runtime.findOwnedDeploymentContainer(value.webName, owner);
        if (web) await runtime.destroy(web);
      }
      // Never restart a scheduler from a release superseded during recovery.
      if (
        project.activeDeploymentId === value.previousDeploymentId &&
        previous &&
        !project.disabledAt
      ) {
        await withDeploymentRuntime(previous, async (old) => {
          for (const ref of value.stopped) {
            if (!(old instanceof DockerRuntime))
              throw new Error("The previous role runtime changed");
            const id = await old.findOwnedDeploymentContainer(ref.containerId, {
              projectId: project.id,
              deploymentId: ref.ownerDeploymentId ?? previous.id,
              role: ref.role,
            });
            if (!id)
              throw new Error(`Previous role ${ref.role} is missing; recovery remains pending`);
            // Re-issue the stop to fence an interrupted stop request, then start
            // only after all candidate removals above have completed.
            await old.stop(id);
            await old.start(id);
          }
          if (value.stopPreviousWeb && previous.containerId) {
            const id =
              old instanceof DockerRuntime
                ? await old.findOwnedDeploymentContainer(previous.containerId, {
                    projectId: project.id,
                    deploymentId:
                      (previous.meta as { webOwnerDeploymentId?: string } | null)
                        ?.webOwnerDeploymentId ?? previous.id,
                  })
                : old.name === "bare"
                  ? previous.containerId
                  : null;
            if (!id) throw new Error("Previous web container is missing; recovery remains pending");
            await old.stop(id);
            await old.start(id);
          }
        });
        if (!value.preserveWeb) {
          const { retryProjectRouting } = await import("../projects/project-runtime.service");
          const routing = await retryProjectRouting(project.id, project.organizationId);
          if (!routing.ok)
            throw new Error(routing.warning ?? "Previous routing could not be restored");
        }
      }
      await writeHandover(dep, { ...value, phase: "complete" }, value.reused ?? []);
      return;
    }

    // The commit intent was written after readiness+routing, before irreversible
    // removal of any previous container. A crash here must complete forward.
    if (
      project.activeDeploymentId !== dep.id &&
      project.activeDeploymentId !== value.previousDeploymentId
    ) {
      // A newer release owns the project. Only retire this stale candidate;
      // never move the active pointer back or restart its predecessor.
      for (const ref of (dep.roleContainers ?? []).filter(
        (ref) => !reusedIds.has(ref.containerId),
      )) {
        const id = await runtime.findOwnedDeploymentContainer(ref.containerId, {
          ...owner,
          role: ref.role,
        });
        if (id) await runtime.destroy(id);
      }
      await writeHandover(dep, { ...value, phase: "complete" });
      return;
    }
    const web =
      value.webContainerId &&
      (await runtime.findOwnedDeploymentContainer(value.webContainerId, {
        ...owner,
        deploymentId: value.preserveWeb?.ownerDeploymentId ?? dep.id,
      }));
    if (!web)
      throw new Error(
        "The published web container could not be verified; recovery remains pending",
      );
    const { readReleaseVersion } = await import("./deployment-lifecycle");
    const version = dep.version ?? (await readReleaseVersion(project.id, dep.commitSha));
    await repos.deployment.setContainerId(dep.id, web);
    await repos.deployment.updateStatus(dep.id, "ready", { errorMessage: null, version });
    await repos.project.setActiveDeployment(project.id, dep.id);
    const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
    if (session)
      await repos.deployment.finishBuildSession(
        session.id,
        "ready",
        session.durationMs ?? dep.buildDurationMs ?? 0,
      );
    if (previous) {
      await withDeploymentRuntime(previous, async (old) => {
        for (const ref of (previous.roleContainers ?? []).filter(
          (ref) => !reusedIds.has(ref.containerId),
        )) {
          if (!(old instanceof DockerRuntime)) throw new Error("The previous role runtime changed");
          const id = await old.findOwnedDeploymentContainer(ref.containerId, {
            projectId: project.id,
            deploymentId: ref.ownerDeploymentId ?? previous.id,
            role: ref.role,
          });
          if (id) await old.destroy(id);
        }
        if (old instanceof DockerRuntime && previous.containerId && previous.containerId !== web) {
          const id = await old.findOwnedDeploymentContainer(previous.containerId, {
            projectId: project.id,
            deploymentId:
              (previous.meta as { webOwnerDeploymentId?: string } | null)?.webOwnerDeploymentId ??
              previous.id,
          });
          if (id) await old.destroy(id);
        }
      });
    }
    await writeHandover(dep, { ...value, phase: "complete" });
    const { onDeploymentReady } = await import("./rollback/rollback-orchestrator");
    const ready = await repos.deployment.findById(dep.id);
    if (ready) await onDeploymentReady({ newDeployment: ready, previousActive: previous });
  });
}

export async function recoverProjectRoleHandovers(
  projectId: string,
  options: { executingDeploymentId?: string; discardDeploymentId?: string } = {},
): Promise<void> {
  await withProjectRuntimeTransition(projectId, async () => {
    const project = await repos.project.findById(projectId);
    if (!project || project.deletionInProgress) return;
    for (const dep of await repos.deployment.listPendingRoleHandovers(projectId)) {
      if (dep.organizationId !== project.organizationId)
        throw new Error("Role handover ownership changed");
      if (dep.id !== options.executingDeploymentId) {
        const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
        if (session?.startedAt && !session.finishedAt) {
          throw new AppError(
            "A role handover is still executing. Retry after it finishes.",
            409,
            "ROLE_HANDOVER_RECOVERY_PENDING",
          );
        }
      }
      if (dep.id === options.discardDeploymentId && readHandover(dep).phase === "kept") {
        await writeHandover(dep, { ...readHandover(dep), phase: "preparing" });
      }
      await recoverHandover(dep, project, dep.id === options.discardDeploymentId);
      // A commit may have advanced the pointer; subsequent recoveries must use
      // its current value, never the predecessor from this loop's first read.
      Object.assign(project, await repos.project.findById(projectId));
    }
  });
}

/** Reuses deployment reconciliation; never interprets an old heartbeat as a dead worker. */
export async function runRoleHandoverRecovery(): Promise<{ recovered: number; pending: number }> {
  let recovered = 0;
  let pending = 0;
  const projects = new Set(
    (await repos.deployment.listPendingRoleHandovers()).map((dep) => dep.projectId),
  );
  for (const projectId of projects) {
    const rows = await repos.deployment.listPendingRoleHandovers(projectId);
    let executing = false;
    for (const dep of rows) {
      const session = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
      if (session?.startedAt && !session.finishedAt) executing = true;
    }
    if (executing) continue;
    try {
      await recoverProjectRoleHandovers(projectId);
      recovered++;
    } catch (error) {
      pending++;
      diagnostics.warn(
        "platform/engine/modules/deployments/role-handover",
        "Role handover recovery remains pending",
        error,
      );
    }
  }
  return { recovered, pending };
}
