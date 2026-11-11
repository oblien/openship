import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import type { PrivateImportPlan, PlannedImportService } from "./platform-import-plan";
import { ensureProject } from "../projects/project-crud.service";
import { mergeEnvVars } from "../projects/project-env.service";
import { createConnection } from "../projects/project-connection.service";
import { getAppConnectionView } from "../apps/app-settings.service";
import { triggerDeployment } from "../deployments/build.service";
import { copyPlatformData, preflightPlatformData } from "./platform-import-data";
import { authorization } from "../../lib/authorization";
import { decrypt } from "../../lib/encryption";
import { disableProject } from "../projects/project-runtime.service";
import {
  prepareRailwayProjectTransfer,
  restoreRailwayProjectTransfer,
} from "./providers/railway-project-transfer";
import { verifyPlatformDeployment } from "./platform-import-health";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";
import { prepareMigrationTarget } from "./migration-runtime";

export interface ImportLifecycle {
  signal: AbortSignal;
  log(text: string): void;
  phase(
    status: "adopting" | "moving_data" | "deploying" | "verifying",
    deploymentId?: string,
  ): Promise<void>;
  wait(deploymentId: string): Promise<boolean>;
  progress(bytes: number, serviceName: string): void;
}

export function orderedImports(services: PlannedImportService[]): PlannedImportService[] {
  const result: PlannedImportService[] = [];
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const visit = (service: PlannedImportService) => {
    if (visited.has(service.source.id) || service.data === "external") return;
    if (visiting.has(service.source.id))
      throw new AppError(
        "Resolve the dependency cycle before importing",
        409,
        "IMPORT_DEPENDENCY_CYCLE",
      );
    visiting.add(service.source.id);
    for (const binding of service.bindings) {
      const dependency = services.find((s) => s.source.id === binding.sourceId);
      if (!dependency)
        throw new AppError("An import dependency is missing", 409, "IMPORT_DEPENDENCY_MISSING");
      visit(dependency);
    }
    visiting.delete(service.source.id);
    visited.add(service.source.id);
    result.push(service);
  };
  // Databases first; workers last unless an explicit dependency requires them.
  for (const service of [...services].sort(
    (a, b) => Number(a.source.kind === "worker") - Number(b.source.kind === "worker"),
  ))
    visit(service);
  return result;
}

/** Provider adapters end at the reviewed source. From here the ordinary project,
 * repository, environment, connection and deployment operations own the import. */
export async function executePlatformImport(
  ctx: ExecutionContext,
  runId: string,
  plan: PrivateImportPlan,
  lifecycle: ImportLifecycle,
) {
  await authorization.authorize(ctx, {
    resourceType: "server",
    resourceId: plan.targetServerId,
    action: "write",
  });
  const projects = new Map<string, string>();
  const services = orderedImports(plan.services);
  lifecycle.log("Checking the complete project's storage and destination configuration");
  await preflightPlatformData(services, lifecycle.signal);
  await prepareMigrationTarget(ctx.organizationId, plan.targetServerId, runId, {
    signal: lifecycle.signal,
    onProgress: lifecycle.log,
  });
  for (const service of services) {
    lifecycle.signal.throwIfAborted();
    await lifecycle.phase("adopting");
    lifecycle.log(`Creating ${service.create.name}`);
    const created = await ensureProject(service.create, ctx.organizationId, ctx, {
      mustCreate: true,
    });
    const projectId = created.project_id;
    if (
      !(await repos.dockerMigrationRun.bindImportedProject(
        runId,
        ctx.organizationId,
        service.source.id,
        projectId,
      ))
    )
      throw new AppError(
        "The import was cancelled while creating a project. Its saved configuration was retained.",
        409,
        "IMPORT_ADMISSION_CLOSED",
      );
    projects.set(service.source.id, projectId);
    // Imports stay on the reviewed revision until the operator enables push
    // deployments after cutover. Use the same project setting as every other flow.
    await repos.project.update(projectId, { autoDeploy: false, runtimeMode: "docker" });
    await mergeEnvVars(projectId, ctx.organizationId, {
      environment: "production",
      deletes: [],
      upserts: Object.entries(service.environment).map(([key, value]) => ({
        key,
        value,
        isSecret: true,
      })),
    });
  }
  const transfer = async (service: PlannedImportService, deploymentId?: string) => {
    if (service.data !== "copy" || (!service.source.database && !service.source.volumes.length))
      return;
    await lifecycle.phase("moving_data", deploymentId);
    await copyPlatformData({
      runId,
      service,
      projectId: projects.get(service.source.id)!,
      deploymentId,
      signal: lifecycle.signal,
      log: lifecycle.log,
      progress: (bytes) => lifecycle.progress(bytes, service.create.name),
    });
  };
  if (plan.sourceControl === "railway-project") {
    await lifecycle.phase("moving_data");
    await prepareRailwayProjectTransfer(runId, plan, lifecycle.signal, lifecycle.log);
    // No destination application starts until every volume has been copied.
    // The transport is identical for databases, queues and arbitrary file stores.
    for (const service of services) await transfer(service);
    await restoreRailwayProjectTransfer(runId, false, lifecycle.log);
  }
  for (const service of services) {
    const projectId = projects.get(service.source.id)!;
    for (const binding of service.bindings) {
      const sourceProjectId = projects.get(binding.sourceId);
      if (!sourceProjectId)
        throw new AppError(
          "The dependency has not finished importing",
          409,
          "IMPORT_DEPENDENCY_NOT_READY",
        );
      const output = (await getAppConnectionView(ctx, sourceProjectId)).outputs.find(
        (output) =>
          output.internal &&
          (output.value || (binding.valueTemplate !== undefined && output.sourceServiceId)),
      );
      if (!output)
        throw new AppError(
          "The imported dependency has no usable connection output",
          409,
          "IMPORT_CONNECTION_NOT_READY",
        );
      await createConnection(
        ctx,
        projectId,
        {
          sourceProjectId,
          outputId: output.id,
          envKey: binding.envKey,
          mode: "internal",
          ...(binding.valueTemplate !== undefined ? { valueTemplate: binding.valueTemplate } : {}),
        },
        { defer: true },
      );
    }
    // File volumes are populated before the application starts. Logical database
    // restore requires the fresh destination database process to be running.
    if (service.transfer !== "cold-volume" && !service.source.database) await transfer(service);
    lifecycle.signal.throwIfAborted();
    await lifecycle.phase("deploying");
    lifecycle.log(
      `Deploying ${service.create.name}${service.source.commit ? ` at ${service.source.commit.slice(0, 12)}` : ""}`,
    );
    const result = await triggerDeployment(ctx, {
      projectId,
      serverId: plan.targetServerId,
      commitSha: service.source.commit,
      branch: service.source.branch,
      trigger: "manual",
    });
    if (!result.deployment)
      throw new AppError(
        "The deployment requires review before it can start",
        409,
        "IMPORT_DEPLOYMENT_DEFERRED",
      );
    const checkpoint = (await repos.dockerMigrationRun.findById(runId))?.recovery.providerImport;
    if (!checkpoint)
      throw new AppError("The import checkpoint is unavailable", 409, "IMPORT_CHECKPOINT_MISSING");
    // Record the build before observing cancellation, so recovery can stop it.
    await repos.dockerMigrationRun.updateRecovery(runId, {
      providerImport: {
        ...checkpoint,
        deployments: { ...checkpoint.deployments, [service.source.id]: result.deployment.id },
      },
    });
    await lifecycle.phase("verifying", result.deployment.id);
    if (!(await lifecycle.wait(result.deployment.id)))
      throw new AppError(
        "The imported deployment did not become healthy. Open its deployment logs to resolve the failure.",
        409,
        "IMPORT_DEPLOYMENT_FAILED",
      );
    if (service.transfer !== "cold-volume" && service.source.database)
      await transfer(service, result.deployment.id);
    await verifyPlatformDeployment(projectId, result.deployment.id, lifecycle.signal);
    const current = await repos.dockerMigrationRun.findById(runId);
    if (!current?.recovery.providerImport)
      throw new AppError("The import checkpoint is unavailable", 409, "IMPORT_CHECKPOINT_MISSING");
    await repos.dockerMigrationRun.updateRecovery(runId, {
      providerImport: {
        ...current.recovery.providerImport,
        completed: [...current.recovery.providerImport.completed, service.source.id],
      },
    });
    lifecycle.log(`${service.create.name} imported; source data retained.`);
  }
}

/** Retain data, but stop newly imported consumers after failure. The deployment
 * identity is checked under the ordinary runtime lock; operator redeploys survive. */
export async function pauseFailedPlatformImport(runId: string) {
  const run = await repos.dockerMigrationRun.findById(runId);
  const checkpoint = run?.recovery.providerImport;
  if (!run || !checkpoint?.cleanupPending) return;
  const plan = JSON.parse(decrypt(checkpoint.planEnc)) as PrivateImportPlan;
  const recover = async () => {
    for (const service of plan.services) {
      if (service.source.database && plan.sourceControl !== "railway-project") continue;
      const projectId = checkpoint.projects[service.source.id];
      const deploymentId = checkpoint.deployments?.[service.source.id];
      if (projectId && deploymentId)
        await disableProject(projectId, run.organizationId, deploymentId);
    }
    // Refuse an operator's replacement deployment and keep the destination
    // runtime locks until source recovery finishes, preventing a concurrent start.
    await restoreRailwayProjectTransfer(runId, true);
    const current = (await repos.dockerMigrationRun.findById(runId))?.recovery.providerImport;
    if (current)
      await repos.dockerMigrationRun.updateRecovery(runId, {
        providerImport: { ...current, cleanupPending: false, planEnc: "" },
      });
  };
  const ids = [...new Set(Object.values(checkpoint.projects))].sort();
  const lock = (index: number): Promise<void> =>
    index === ids.length ? recover() : withProjectRuntimeLock(ids[index], () => lock(index + 1));
  await lock(0);
}
