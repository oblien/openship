import { repos, type Deployment, type Service } from "@repo/db";
import type { BuildLogger } from "@repo/adapters";
import { decryptEnvMap } from "../../../lib/encryption";
import { mergeServiceDeployEnv } from "./service-env-layers";
import { newerThanRestoredRelease } from "./project-services";
import { replaysFrozenDeployment } from "../deployment-artifacts";

/** Shared by early validation and activation so both use the same saved layers. */
export async function loadServiceDeployEnvironment(opts: {
  projectId: string;
  dep: Pick<Deployment, "environment" | "trigger"> & Partial<Pick<Deployment, "meta">>;
  service: Pick<Service, "id" | "name" | "environment" | "advanced">;
  projectEnv: Record<string, string>;
  frozenEnv: Record<string, string>;
  logger: BuildLogger;
}) {
  const { projectId, dep, service, projectEnv, frozenEnv, logger } = opts;
  const saved = await repos.project.getEnvMap(projectId, dep.environment, service.id);
  const serviceEnv = decryptEnvMap(saved, (key) => {
    logger.log(
      `Warning: failed to decrypt env var "${key}" for service "${service.name}", skipping.\n`,
      "warn",
      { serviceName: service.name },
    );
  });
  return mergeServiceDeployEnv(
    {
      project: projectEnv,
      frozen: frozenEnv,
      inline: service.environment ?? {},
      templateKeys: service.advanced?.environmentTemplateKeys,
      service: serviceEnv,
    },
    replaysFrozenDeployment(dep) && Object.keys(frozenEnv).length > 0,
  );
}

/** Reject deterministic configuration errors before any image is built/pulled
 * or service activated. Untouched services cannot block a scoped deployment. */
export async function assertRequiredServiceEnvironment(opts: {
  projectId: string;
  dep: Deployment;
  targetServiceIds?: ReadonlySet<string>;
  logger: BuildLogger;
}) {
  const { projectId, dep, targetServiceIds, logger } = opts;
  const newerThanRelease = newerThanRestoredRelease(dep);
  const services = (await repos.service.listByProject(projectId)).filter(
    (service) =>
      service.enabled &&
      (!targetServiceIds || targetServiceIds.has(service.id)) &&
      !newerThanRelease(service) &&
      service.advanced?.environmentTemplateKeys?.length,
  );
  if (services.length === 0) return;

  const projectEnv = decryptEnvMap(
    await repos.project.getEnvMap(projectId, dep.environment, null),
    (key) => logger.log(`Warning: failed to decrypt project env var "${key}", skipping.\n`, "warn"),
  );
  const frozenEnv = decryptEnvMap((dep.envVars ?? {}) as Record<string, string>, (key) => {
    logger.log(`Warning: failed to decrypt deployment env var "${key}", skipping.\n`, "warn");
  });
  const failures: string[] = [];
  for (const service of services) {
    const resolved = await loadServiceDeployEnvironment({
      projectId,
      dep,
      service,
      projectEnv,
      frozenEnv,
      logger,
    });
    const missing = [...new Set(resolved.missingRequired.map((item) => item.variable))].sort();
    if (missing.length > 0) failures.push(`Service "${service.name}": ${missing.join(", ")}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Required Compose environment variables are not configured. ${failures.join("; ")}`,
    );
  }
}
