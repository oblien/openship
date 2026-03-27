/**
 * Compose deploy service — deploys multi-service projects.
 *
 * Instead of building a single image and running one container,
 * compose deployments:
 *   1. Ensure a shared Docker network for the project
 *   2. Deploy each enabled service as a separate container on that network
 *   3. Track per-service container state in serviceDeployment rows
 *   4. Services discover each other by name (hostname = service name)
 */

import { repos, type Deployment, type Project, type Service } from "@repo/db";
import { getProjectType, type StackId } from "@repo/core";
import { BuildLogger, DockerRuntime, type LogEntry, type MultiServiceRuntimeAdapter } from "@repo/adapters";
import { decryptEnvMap } from "../../../lib/encryption";
import * as sessionManager from "../session-manager";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposeDeployResult {
  status: "ready" | "failed";
  summary: {
    total: number;
    successful: number;
    failed: number;
    failedServices: string[];
  };
  services: Array<{
    serviceId: string;
    serviceName: string;
    containerId?: string;
    status: string;
    ip?: string;
    hostPort?: number;
    error?: string;
  }>;
  warning?: string;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a project is a compose / multi-service project */
export function isComposeProject(project: Project): boolean {
  const framework = project.framework as StackId | undefined;
  if (!framework) return false;
  try {
    return getProjectType(framework) === "services";
  } catch {
    return framework === "docker-compose";
  }
}

/** Topological sort of services by dependsOn — respects dependency order. */
function topoSort(services: Service[]): Service[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const sorted: Service[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(svc: Service) {
    if (visited.has(svc.name)) return;
    if (visiting.has(svc.name)) {
      // Circular dependency — break cycle
      sorted.push(svc);
      visited.add(svc.name);
      return;
    }
    visiting.add(svc.name);
    const deps = (svc.dependsOn as string[]) ?? [];
    for (const depName of deps) {
      const dep = byName.get(depName);
      if (dep) visit(dep);
    }
    visiting.delete(svc.name);
    visited.add(svc.name);
    sorted.push(svc);
  }

  for (const svc of services) {
    visit(svc);
  }
  return sorted;
}

// ─── Main compose deploy function ────────────────────────────────────────────

/**
 * Deploy all services for a compose project.
 * Called from the compose pipeline after the build phase.
 */
export async function deployComposeServices(
  project: Project,
  dep: Deployment,
  runtime: MultiServiceRuntimeAdapter,
  logger: BuildLogger,
  opts?: {
    builtImages?: Map<string, string>;
    buildFailures?: Map<string, string>;
  },
): Promise<ComposeDeployResult> {
  const services = await repos.service.listByProject(project.id);
  const enabled = services.filter((s) => s.enabled);

  if (enabled.length === 0) {
    const hasServices = services.length > 0;
    return {
      status: "failed",
      summary: {
        total: 0,
        successful: 0,
        failed: 0,
        failedServices: [],
      },
      services: [],
      error: hasServices
        ? "All compose services are currently disabled. Re-syncing the compose file should re-enable them."
        : "No compose services were found for this project. Sync the compose file before deploying.",
    };
  }

  // Sort by dependency order
  const ordered = topoSort(enabled);

  logger.step("deploy", "running", `Deploying ${ordered.length} services...`);
  logger.log("Preparing shared service group for compose deployment...\n");

  // 1. Ensure shared runtime group (Docker network today, cloud workspace later)
  const group = await runtime.ensureServiceGroup({
    deploymentId: dep.id,
    projectId: project.id,
    slug: project.slug,
  });
  logger.log(`Service group ready for ${project.slug}.\n`);

  // 2. Load project-level env vars (shared across services)
  const projectEnvMap = await repos.project.getEnvMap(project.id, dep.environment);
  const decryptedProjectEnv = decryptEnvMap(projectEnvMap, (key) => {
    logger.log(`Warning: failed to decrypt project env var "${key}", skipping.\n`, "warn");
  });

  // 3. Decrypt deployment-level env var overrides
  const depEnvVars = dep.envVars as Record<string, string> | null;
  const depEnv = depEnvVars
    ? decryptEnvMap(depEnvVars, (key) => {
        logger.log(`Warning: failed to decrypt deployment env var "${key}", skipping.\n`, "warn");
      })
    : {};

  // 4. Load previous service containers so each service is replaced in-place
  //    instead of tearing down the whole app before the first deploy attempt.
  const previousServiceDeps = project.activeDeploymentId
    ? await repos.service.listByDeployment(project.activeDeploymentId)
    : [];
  const previousByServiceId = new Map(previousServiceDeps.map((row) => [row.serviceId, row]));
  const enabledServiceIds = new Set(enabled.map((svc) => svc.id));

  // 5. Deploy each service
  const results: ComposeDeployResult["services"] = [];
  let successful = 0;

  for (const svc of ordered) {
    // Ownership guard — ensure this service actually belongs to the project
    if (svc.projectId !== project.id) continue;

    // Load service-specific env vars
    const serviceEnvMap = await repos.project.getEnvMap(project.id, dep.environment, svc.id);
    const decryptedServiceEnv = decryptEnvMap(serviceEnvMap, (key) => {
      logger.log(`Warning: failed to decrypt env var "${key}" for service "${svc.name}", skipping.\n`, "warn");
    });

    // Merge: compose env (defaults) → project env → service-specific env → deployment overrides
    const mergedEnv: Record<string, string> = {
      ...(svc.environment as Record<string, string> ?? {}),
      ...decryptedProjectEnv,
      ...decryptedServiceEnv,
      ...depEnv,
    };

    const buildFailure = opts?.buildFailures?.get(svc.id);
    if (buildFailure) {
      logger.log(`Service "${svc.name}" build failed: ${buildFailure}\n`, "error");
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: buildFailure,
      });
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failed",
        imageRef: svc.image ?? null,
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: buildFailure,
      });
      continue;
    }

    const image = opts?.builtImages?.get(svc.id) ?? svc.image ?? "";
    if (!image) {
      const message = `No image available for service "${svc.name}"`;
      logger.log(`${message}\n`, "error");
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failed",
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: message,
      });
      continue;
    }

    logger.log(`Deploying service "${svc.name}" (${image})...\n`);

    // Broadcast per-service "deploying" status to SSE subscribers
    sessionManager.broadcastServiceStatus(dep.id, {
      serviceName: svc.name,
      serviceId: svc.id,
      status: "deploying",
    });

    try {
      const previous = previousByServiceId.get(svc.id);
      if (previous?.containerId) {
        try {
          await runtime.destroy(previous.containerId);
          logger.log(`Replaced previous container for "${svc.name}" (${previous.containerId.slice(0, 12)}).\n`);
          if (
            previous.imageRef &&
            previous.imageRef !== image &&
            runtime instanceof DockerRuntime
          ) {
            await runtime.removeImage(previous.imageRef).catch((err) => {
              const message = err instanceof Error ? err.message : "Unknown error";
              logger.log(`Warning: failed to remove previous image for "${svc.name}": ${message}\n`, "warn");
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          logger.log(`Warning: failed to stop previous container for "${svc.name}": ${message}\n`, "warn");
        }
      }

      const result = await runtime.deployServiceWorkload(
        group,
        {
          deploymentId: dep.id,
          projectId: project.id,
          slug: project.slug,
          serviceName: svc.name,
          image,
          ports: (svc.ports as string[]) ?? [],
          environment: mergedEnv,
          volumes: (svc.volumes as string[]) ?? [],
          command: svc.command ?? undefined,
          restart: svc.restart ?? "unless-stopped",
        },
        (entry: LogEntry) => {
          sessionManager.appendLog(dep.id, entry);
        },
      );

      // Record service deployment
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        containerId: result.containerId,
        status: result.status,
        imageRef: image,
        hostPort: result.hostPort ?? null,
        ip: result.ip ?? null,
      });

      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        containerId: result.containerId,
        status: result.status,
        ip: result.ip,
        hostPort: result.hostPort,
      });
      successful += 1;

      // Broadcast per-service "running" status to SSE subscribers
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "running",
        containerId: result.containerId,
        hostPort: result.hostPort,
      });

      logger.log(`Service "${svc.name}" deployed successfully.\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.log(`Service "${svc.name}" failed: ${message}\n`, "error");

      // Broadcast per-service "failed" status to SSE subscribers
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });

      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failed",
        imageRef: image,
      });

      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: message,
      });
    }
  }

  for (const previous of previousServiceDeps) {
    if (!previous.containerId || enabledServiceIds.has(previous.serviceId)) continue;
    try {
      await runtime.destroy(previous.containerId);
      logger.log(`Stopped disabled service container (${previous.containerId.slice(0, 12)}).\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.log(`Warning: failed to stop disabled service container: ${message}\n`, "warn");
    }
  }

  const failed = results.filter((r) => r.status === "failed");
  const failedNames = failed.map((r) => r.serviceName);
  const warning = failed.length > 0
    ? `${failed.length}/${ordered.length} services failed: ${failedNames.join(", ")}`
    : undefined;
  const firstFailure = failed.find((service) => service.error?.trim())?.error;

  if (successful === ordered.length) {
    logger.step("deploy", "completed", `All ${ordered.length} services deployed.`);
  } else if (successful > 0) {
    logger.step(
      "deploy",
      "completed",
      `Deployed ${successful}/${ordered.length} services. ${failed.length} service${failed.length === 1 ? "" : "s"} still need attention.`,
    );
    logger.log(`Deployment completed with warnings: ${warning}\n`, "warn");
  } else {
    logger.step(
      "deploy",
      "failed",
      `${failed.length}/${ordered.length} services failed to deploy.`,
    );
  }

  return {
    status: successful > 0 ? "ready" : "failed",
    summary: {
      total: ordered.length,
      successful,
      failed: failed.length,
      failedServices: failedNames,
    },
    services: results,
    warning,
    error: successful > 0 ? undefined : firstFailure ?? "No services deployed successfully",
  };
}
