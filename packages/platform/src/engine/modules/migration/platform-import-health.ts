import { setTimeout as delay } from "node:timers/promises";
import { AppError, SYSTEM } from "@repo/core";
import { repos } from "@repo/db";
import { watchContainerStability } from "@repo/adapters";
import { createMigrationDockerRuntime } from "./migration-runtime";
import { containerIdForService } from "../services/service-container";
import { isStaticService } from "../../lib/deployable-service";

/** A normal deployment can finish with warnings for failed sidecars. Migration
 * must verify every imported runtime before it offers cutover. */
export async function verifyPlatformDeployment(
  projectId: string,
  deploymentId: string,
  signal: AbortSignal,
) {
  const project = await repos.project.findById(projectId);
  const deployment = await repos.deployment.findById(deploymentId);
  if (
    !project?.serverId ||
    !deployment ||
    deployment.projectId !== projectId ||
    project.activeDeploymentId !== deploymentId
  )
    throw new AppError(
      "The destination changed during import. Review its deployment before retrying.",
      409,
      "IMPORT_TARGET_CHANGED",
    );
  const services = (await repos.service.listByProject(projectId)).filter(
    (s) => s.enabled !== false && !isStaticService(s),
  );
  const containers = services.length
    ? await Promise.all(services.map((s) => containerIdForService(deployment, s)))
    : project.productionMode === "static"
      ? []
      : [deployment.containerId];
  if (containers.some((id) => !id))
    throw new AppError(
      "An imported service has no running container. Review its deployment logs.",
      409,
      "IMPORT_RUNTIME_MISSING",
    );
  if (!containers.length) return;
  const runtime = await createMigrationDockerRuntime(project.serverId, project.organizationId);
  try {
    const verdicts = await Promise.all(
      containers.map((id) =>
        watchContainerStability(
          {
            sample: async () => {
              signal.throwIfAborted();
              return runtime.sampleStability(id!);
            },
            sleep: (ms) => delay(ms, undefined, { signal }),
          },
          {
            windowMs: SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS,
            pollMs: SYSTEM.DEPLOYMENTS.STABILIZE_POLL_MS,
            crashRestarts: SYSTEM.DEPLOYMENTS.STABILIZE_CRASH_RESTARTS,
          },
        ),
      ),
    );
    if (verdicts.some((result) => !result.ok))
      throw new AppError(
        "An imported service did not remain healthy. Copied data was retained; review its deployment logs.",
        409,
        "IMPORT_RUNTIME_UNHEALTHY",
      );
  } finally {
    await runtime.dispose();
  }
}
