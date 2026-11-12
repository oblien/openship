import { AppError, ConflictError, ValidationError } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import type { PrivateImportPlan, PlannedImportService } from "./platform-import-plan";
import { ensureProject } from "../projects/project-crud.service";
import { mergeServiceEnvVars } from "../services/service-environment-state";
import { createService } from "../services/service.service";
import { platformImportRoutes, platformImportSourceService } from "./platform-import-project";
import { saveMigrationRoutes } from "./migration-routes";
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
  if (!plan.project)
    throw new AppError(
      "Review this import again before starting it.",
      409,
      "IMPORT_REVIEW_EXPIRED",
    );
  const services = orderedImports(plan.services);
  lifecycle.log("Checking the complete project's storage and destination configuration");
  await preflightPlatformData(services, lifecycle.signal);
  await prepareMigrationTarget(ctx.organizationId, plan.targetServerId, runId, {
    signal: lifecycle.signal,
    onProgress: lifecycle.log,
  });
  lifecycle.signal.throwIfAborted();
  await lifecycle.phase("adopting");
  lifecycle.log(`Creating project ${plan.project.name}`);
  const { project_id: projectId } = await ensureProject(plan.project, ctx.organizationId, ctx, {
    mustCreate: true,
  });
  for (const service of services) {
    if (
      !(await repos.dockerMigrationRun.bindImportedProject(
        runId,
        ctx.organizationId,
        service.source.id,
        projectId,
      ))
    )
      throw new AppError(
        "The import was cancelled while creating its project. Its saved configuration was retained.",
        409,
        "IMPORT_ADMISSION_CLOSED",
      );
  }
  await repos.project.update(projectId, { autoDeploy: false, runtimeMode: "docker" });
  for (const service of services) {
    lifecycle.signal.throwIfAborted();
    if (!service.create.services?.length)
      await createService(ctx, projectId, platformImportSourceService(service, services));
  }
  // Use the same pending-domain and ownership path as server/Docker migration.
  // Validate every route before pausing Railway or copying data. Deployment will
  // reconcile routing normally; neither this step nor import changes external DNS.
  try {
    await saveMigrationRoutes(ctx, projectId, platformImportRoutes(services), lifecycle.log);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof ConflictError)
      throw new AppError(error.message, error.statusCode, "IMPORT_DOMAIN_REVIEW_REQUIRED");
    throw error;
  }
  const rows = await repos.service.listByProject(projectId);
  const bySource = new Map(
    services.map((service) => {
      const row = rows.find((row) => row.name === service.create.name);
      if (!row)
        throw new AppError(
          "The imported service was not created.",
          409,
          "IMPORT_TARGET_SERVICE_MISSING",
        );
      return [service.source.id, row] as const;
    }),
  );
  const checkpoint = async () => {
    const current = (await repos.dockerMigrationRun.findById(runId))?.recovery.providerImport;
    if (!current)
      throw new AppError("The import checkpoint is unavailable", 409, "IMPORT_CHECKPOINT_MISSING");
    return current;
  };
  await repos.dockerMigrationRun.updateRecovery(runId, {
    providerImport: {
      ...(await checkpoint()),
      services: Object.fromEntries([...bySource].map(([id, row]) => [id, row.id])),
    },
  });
  const saveEnvironment = async (sourceId: string, values: Record<string, string>) => {
    await mergeServiceEnvVars(ctx, projectId, bySource.get(sourceId)!.id, {
      environment: "production",
      deletes: [],
      upserts: Object.entries(values).map(([key, value]) => ({
        key,
        value,
        isSecret: true,
        sourceId: null,
      })),
    });
  };
  for (const service of services) await saveEnvironment(service.source.id, service.environment);
  for (const service of services) {
    const values: Record<string, string> = {};
    for (const binding of service.bindings) {
      // Railway already resolved these against native service DNS during review.
      if (Object.hasOwn(service.environment, binding.envKey)) continue;
      const dependency = bySource.get(binding.sourceId);
      if (!dependency)
        throw new AppError("An import dependency is missing", 409, "IMPORT_DEPENDENCY_MISSING");
      const output = (await getAppConnectionView(ctx, projectId)).outputs.find(
        (output) => output.internal && output.sourceServiceId === dependency.id && output.value,
      );
      if (!output)
        throw new AppError(
          "The imported dependency has no usable connection output",
          409,
          "IMPORT_CONNECTION_NOT_READY",
        );
      values[binding.envKey] =
        binding.valueTemplate === undefined
          ? output.value
          : binding.valueTemplate.replaceAll("${host}", dependency.name);
    }
    if (Object.keys(values).length) await saveEnvironment(service.source.id, values);
  }
  const transfer = async (service: PlannedImportService, deploymentId?: string) => {
    if (service.data !== "copy" || (!service.source.database && !service.source.volumes.length))
      return;
    await lifecycle.phase("moving_data", deploymentId);
    await copyPlatformData({
      runId,
      service,
      projectId,
      serviceId: bySource.get(service.source.id)!.id,
      deploymentId,
      signal: lifecycle.signal,
      log: lifecycle.log,
      progress: (bytes) => lifecycle.progress(bytes, service.create.name),
    });
  };
  const deploy = async (selected: PlannedImportService[]) => {
    lifecycle.signal.throwIfAborted();
    await lifecycle.phase("deploying");
    lifecycle.log(
      `Deploying ${plan.project.name}: ${selected.map((service) => service.create.name).join(", ")}`,
    );
    const source = services.find((service) => service.create.gitRepo)?.source;
    const result = await triggerDeployment(ctx, {
      projectId,
      serverId: plan.targetServerId,
      commitSha: source?.commit,
      branch: source?.branch,
      trigger: "manual",
      serviceIds: selected.map((service) => bySource.get(service.source.id)!.id),
      strictServiceScope: true,
    });
    if (!result.deployment)
      throw new AppError(
        "The deployment requires review before it can start",
        409,
        "IMPORT_DEPLOYMENT_DEFERRED",
      );
    const current = await checkpoint();
    await repos.dockerMigrationRun.updateRecovery(runId, {
      providerImport: {
        ...current,
        ownedDeploymentIds: [...(current.ownedDeploymentIds ?? []), result.deployment.id],
        deployments: {
          ...current.deployments,
          ...Object.fromEntries(
            selected.map((service) => [service.source.id, result.deployment.id]),
          ),
        },
      },
    });
    await lifecycle.phase("verifying", result.deployment.id);
    if (!(await lifecycle.wait(result.deployment.id)))
      throw new AppError(
        "The imported deployment did not become healthy. Open its deployment logs to resolve the failure.",
        409,
        "IMPORT_DEPLOYMENT_FAILED",
      );
    return result.deployment.id;
  };
  if (plan.sourceControl === "railway-project") {
    await lifecycle.phase("moving_data");
    await prepareRailwayProjectTransfer(runId, plan, lifecycle.signal, lifecycle.log);
    // Every source volume is copied before any destination workload starts.
    for (const service of services) await transfer(service);
    await restoreRailwayProjectTransfer(runId, false, lifecycle.log);
  } else {
    for (const service of services) {
      if (service.source.database && service.data === "copy") {
        // Logical restores start only their database. Consumers remain stopped
        // until the shared deployment admits the complete imported project.
        const deploymentId = await deploy([service]);
        await transfer(service, deploymentId);
      } else await transfer(service);
    }
  }
  const deploymentId = await deploy(services);
  await verifyPlatformDeployment(projectId, deploymentId, lifecycle.signal);
  await repos.dockerMigrationRun.updateRecovery(runId, {
    providerImport: {
      ...(await checkpoint()),
      completed: services.map((service) => service.source.id),
    },
  });
  lifecycle.log(
    `${plan.project.name} imported with ${services.length} services; source data retained.`,
  );
}

/** Retain data, but stop newly imported consumers after failure. The deployment
 * identity is checked under the ordinary runtime lock; operator redeploys survive. */
export async function pauseFailedPlatformImport(runId: string) {
  const run = await repos.dockerMigrationRun.findById(runId);
  const checkpoint = run?.recovery.providerImport;
  if (!run || !checkpoint?.cleanupPending) return;
  const plan = JSON.parse(decrypt(checkpoint.planEnc)) as PrivateImportPlan;
  const recover = async () => {
    const stopped = new Set<string>();
    for (const service of plan.services) {
      const projectId = checkpoint.projects[service.source.id];
      const deploymentId = checkpoint.deployments?.[service.source.id];
      if (projectId && deploymentId && !stopped.has(projectId)) {
        const active = (await repos.project.findById(projectId))?.activeDeploymentId;
        // A failed full deployment may leave this import's database-only
        // deployment active. An operator's replacement is still never stopped.
        const expected =
          active && checkpoint.ownedDeploymentIds?.includes(active) ? active : deploymentId;
        await disableProject(projectId, run.organizationId, expected);
        stopped.add(projectId);
      }
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
