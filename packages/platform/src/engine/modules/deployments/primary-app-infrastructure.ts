import { SYSTEM } from "@repo/core";
import { setTimeout as delay } from "node:timers/promises";
import { verifyDeployedContainers } from "./stability-audit.service";
import { repos, type Project, type Deployment, type ServiceDeployment } from "@repo/db";
import { DockerRuntime, isMultiServiceRuntime, type RuntimeAdapter } from "@repo/adapters";
import { findActiveDeployment, findProjectDeployment } from "../../lib/active-deployment";
import { throwIfDeploymentCancelled } from "./deployment-cancellation";
import { deployComposeServices } from "./compose/deploy.service";
import { primaryAppWithInfrastructure } from "./compose/project-services";
import { replaysFrozenDeployment } from "./deployment-artifacts";
import type { DeploymentConfigSnapshot } from "./build.service";
import type { DeployPhaseInputs } from "./build-pipeline";

type InfrastructurePhase = Pick<
  DeployPhaseInputs,
  | "primaryApp"
  | "project"
  | "dep"
  | "runtime"
  | "logger"
  | "snapshot"
  | "ctx"
  | "prodResources"
  | "buildSessionId"
  | "targetExecutor"
  | "hostPortTarget"
  | "cancellationSignal"
>;

async function waitForInfrastructure(phase: InfrastructurePhase, rows: ServiceDeployment[]) {
  const deadline = Date.now() + SYSTEM.DEPLOYMENTS.READINESS_TIMEOUT_MS;
  await Promise.all(
    rows.map(async (row) => {
      while (true) {
        throwIfDeploymentCancelled(phase.cancellationSignal);
        const sample = await phase.runtime.sampleStability?.(row.containerId!);
        if (!sample) throw new Error(`Could not verify attached service "${row.serviceName}".`);
        if (
          (sample.state !== "running" && sample.state !== "restarting") ||
          sample.health === "unhealthy"
        )
          throw new Error(`Attached service "${row.serviceName}" is not healthy.`);
        if (sample.state === "running" && sample.health !== "starting") break;
        if (Date.now() >= deadline)
          throw new Error(`Attached service "${row.serviceName}" did not become healthy.`);
        await delay(250, undefined, { signal: phase.cancellationSignal });
      }
    }),
  );
  const findings = await verifyDeployedContainers(
    phase.runtime,
    rows.map((row) => ({
      serviceName: row.serviceName ?? row.serviceId,
      containerId: row.containerId!,
    })),
    phase.logger,
    { windowMs: SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS },
  );
  if (findings.length !== rows.length || findings.some((finding) => !finding.verdict.ok))
    throw new Error(
      "Attached infrastructure did not pass startup verification. The app was not activated.",
    );
}

async function copyRows(rows: ServiceDeployment[], deploymentId: string) {
  for (const { id: _id, createdAt: _created, updatedAt: _updated, ...row } of rows) {
    await repos.service.upsertServiceDeployment({ ...row, deploymentId, checkRunId: null });
  }
}

/** Roles-only edits and app rollbacks carry infrastructure; they do not replay
 * old database configuration, credentials, commands or data. */
export async function carryAttachedInfrastructure(phase: InfrastructurePhase) {
  const retryFrom = phase.snapshot.retryBuildFromDeploymentId;
  const active =
    (await findActiveDeployment(phase.project)) ??
    (retryFrom ? await findProjectDeployment(phase.project, retryFrom) : null);
  if (
    active &&
    ((active.meta as DeploymentConfigSnapshot | null)?.serverId ?? null) !==
      (phase.snapshot.serverId ?? null)
  )
    throw new Error("Use migration to move attached services to another server.");
  const ids = new Set(phase.primaryApp!.infrastructure.map((service) => service.id));
  const rows = active
    ? (await repos.service.listByDeployment(active.id)).filter((row) => ids.has(row.serviceId))
    : [];
  if (
    rows.length !== ids.size ||
    rows.some((row) => row.status !== "success" || !row.containerId)
  ) {
    throw new Error("Attached services must be running before restoring or configuring this app.");
  }
  for (const row of rows) {
    const info = await phase.runtime.getContainerInfo(row.containerId!);
    if (info.status !== "running")
      throw new Error("An attached service is not running. Start it before restoring this app.");
  }
  await waitForInfrastructure(phase, rows);
  await copyRows(rows, phase.dep.id);
}

/** Infrastructure uses the existing scoped service reconciler; the candidate
 * app keeps the existing release/role/web activation pipeline and its journal.
 * Infrastructure is independently live state: keep its durable references on
 * the active app even if a later migration or role startup fails. */
export async function prepareAttachedInfrastructure(phase: InfrastructurePhase) {
  const { project, dep, runtime, logger, snapshot } = phase;
  if (!phase.primaryApp || !isMultiServiceRuntime(runtime))
    throw new Error("Attached services require Docker.");
  if (
    replaysFrozenDeployment(dep) ||
    (snapshot.roleConfiguration && !snapshot.targetServiceIds?.length)
  ) {
    await carryAttachedInfrastructure(phase);
    return;
  }
  const current = primaryAppWithInfrastructure(
    { ...project, ...snapshot },
    await repos.service.listByProject(project.id),
  );
  const allIds = new Set(phase.primaryApp.infrastructure.map((service) => service.id));
  const ids = new Set(snapshot.targetServiceIds?.length ? snapshot.targetServiceIds : allIds);
  if ([...ids].some((id) => !allIds.has(id)))
    throw new Error("Choose attached infrastructure services for this scope.");
  if (
    !current ||
    current.app.id !== phase.primaryApp.app.id ||
    current.infrastructure.length !== allIds.size ||
    current.infrastructure.some((service) => !allIds.has(service.id))
  ) {
    throw new Error("Project services changed while this app was building. Retry the deployment.");
  }
  // The materialized app keeps its service identity after the last attached
  // service is removed. There is no infrastructure scope to reconcile (#1308).
  if (allIds.size === 0) return;
  const active = await findActiveDeployment(project);
  if (
    active &&
    ((active.meta as { serverId?: string } | null)?.serverId ?? null) !==
      (snapshot.serverId ?? null)
  )
    throw new Error(
      "Move attached infrastructure with the migration workflow before changing the app's server.",
    );
  let anchor = active;
  // A first app deploy can fail AFTER its database becomes ready. Recover that
  // independently successful infrastructure instead of restarting it on retry.
  {
    const attempts = (
      await Promise.all([...ids].map((id) => repos.serviceDeployment.listByService(id)))
    )
      .flat()
      .filter((row) => row.status === "success" && row.containerId && row.deploymentId !== dep.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    for (const attempt of attempts) {
      const parent = await findProjectDeployment(project, attempt.deploymentId);
      if (
        parent &&
        (!anchor || parent.createdAt > anchor.createdAt) &&
        !["queued", "building", "deploying", "reconciling"].includes(parent.status) &&
        ((parent.meta as { serverId?: string } | null)?.serverId ?? null) ===
          (snapshot.serverId ?? null)
      ) {
        anchor = parent;
        break;
      }
    }
  }
  throwIfDeploymentCancelled(phase.cancellationSignal);
  logger.log("Preparing attached infrastructure before application activation…\n");
  let result: Awaited<ReturnType<typeof deployComposeServices>>;
  let rows: ServiceDeployment[] = [];
  try {
    result = await deployComposeServices(
      { ...project, activeDeploymentId: anchor?.id ?? null },
      dep,
      runtime,
      logger,
      {
        targetServiceIds: ids,
        strictScope: true,
        keepUnchanged: !snapshot.targetServiceIds?.length,
        resources: phase.prodResources,
        buildSessionId: phase.buildSessionId,
        // These are private infrastructure services. The app's own preflight
        // handles edge preparation; this phase must not claim its routes.
        usesManagedRouting: false,
        serverId: snapshot.serverId,
        executor: phase.targetExecutor,
        hostPortTarget: phase.hostPortTarget,
        signal: phase.cancellationSignal,
      },
    );
  } finally {
    rows = (await repos.service.listByDeployment(dep.id)).filter((row) => ids.has(row.serviceId));
    // Preserve confirmed infrastructure even if cancellation lands between
    // Docker activation and the enclosing application's activation phase.
    if (active)
      await copyRows(
        rows.filter((row) => row.status === "success"),
        active.id,
      );
  }
  throwIfDeploymentCancelled(phase.cancellationSignal);
  if (
    result.status !== "ready" ||
    rows.length !== ids.size ||
    rows.some((row) => row.status !== "success")
  ) {
    throw new Error(
      result.error ?? "Attached infrastructure is not ready. The application was not activated.",
    );
  }
  await waitForInfrastructure(phase, rows);
  if (active && snapshot.targetServiceIds?.length) {
    await copyRows(
      (await repos.service.listByDeployment(active.id)).filter(
        (row) => allIds.has(row.serviceId) && !ids.has(row.serviceId),
      ),
      dep.id,
    );
    // The primary app was deliberately retained; preserve its frozen env for
    // later restores, after the infrastructure has consumed the requested env.
    await repos.deployment.updateStatus(dep.id, "deploying", { envVars: active.envVars });
  }
}

/** Reuse the existing immutable-image configuration rollout for infrastructure-
 * only scopes. It preserves web and every unchanged worker/scheduler replica. */
export async function prepareInfrastructureScopeSnapshot(
  project: Project,
  dep: Deployment,
  snapshot: DeploymentConfigSnapshot,
  runtime: RuntimeAdapter,
) {
  const active = await findActiveDeployment(project);
  if (!active?.containerId || !(runtime instanceof DockerRuntime))
    throw new Error("Deploy the primary app before deploying attached services independently.");
  if (
    ((active.meta as DeploymentConfigSnapshot | null)?.serverId ?? null) !==
    (snapshot.serverId ?? null)
  )
    throw new Error("Use migration to move attached services to another server.");
  const { inspectRoleConfigurationImage } = await import("../projects/role-configuration.service");
  const identity = await inspectRoleConfigurationImage(runtime, project, active);
  const targetServiceIds = snapshot.targetServiceIds;
  const composeServices = snapshot.composeServices;
  const next: DeploymentConfigSnapshot = {
    ...(active.meta as DeploymentConfigSnapshot),
    targetServiceIds,
    composeServices,
    handoverAppImage: identity.imageId,
    refreshAppDeploymentId: active.id,
    webOwnerDeploymentId: identity.ownerDeploymentId,
    roleConfiguration: {
      sourceDeploymentId: active.id,
      webContainerId: active.containerId,
      webOwnerDeploymentId: identity.ownerDeploymentId,
      imageId: identity.imageId,
    },
  };
  for (const key of Object.keys(snapshot))
    delete (snapshot as unknown as Record<string, unknown>)[key];
  Object.assign(snapshot, next);
  dep.meta = snapshot;
  dep.url = active.url;
  await repos.deployment.updateStatus(dep.id, "building", {
    meta: snapshot,
    commitSha: active.commitSha,
    commitMessage: active.commitMessage,
  });
}

export async function recordPrimaryAppService(phase: DeployPhaseInputs, containerId: string) {
  const info = await phase.runtime.getContainerInfo(containerId);
  await repos.service.upsertServiceDeployment({
    serviceId: phase.primaryApp!.app.id,
    serviceName: phase.primaryApp!.app.name,
    deploymentId: phase.dep.id,
    containerId,
    status: "success",
    imageRef: phase.buildResult.imageRef!,
    imageDigest: info.imageId ?? null,
    ip: info.ip ?? null,
    hostPort: info.hostPort ?? null,
    hostPorts: info.hostPortByContainerPort ?? null,
    allocatedResources: {
      containerId,
      cpuCores: phase.prodResources.cpuCores,
      memoryMb: phase.prodResources.memoryMb,
    },
  });
}
