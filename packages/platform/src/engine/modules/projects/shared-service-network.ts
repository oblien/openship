import { findActiveDeployment, listActiveServiceDeployments } from "@repo/platform/engine/lib/active-deployment";
import { ValidationError } from "@repo/core";
import { repos, type Project, type Deployment } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";
import { containerIdForService, liveContainerIdWithRuntime, resolveServicePlatform } from "../services/service-container";
import { disposePlatform } from "../../lib/deployment-runtime";
import { usesPrivateNetwork } from "./project-connection.util";

/** Names come from immutable IDs, so different projects' `db` aliases never collide. */
export function sharedServiceAlias(serviceId: string): string {
  return `shared-${serviceId.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()}`;
}

export function sharedServiceNetwork(serviceId: string): string {
  return `openship-${sharedServiceAlias(serviceId)}`;
}

export async function ensureSharedServiceNetwork(
  source: Project,
  serviceId: string,
  runtime?: RuntimeAdapter,
  deploymentId = source.activeDeploymentId,
): Promise<void> {
  if (!deploymentId) throw new ValidationError("Deploy the source service before connecting it to another project.");
  const [service, deployment] = await Promise.all([
    repos.service.findById(serviceId), repos.deployment.findById(deploymentId),
  ]);
  if (!service || service.projectId !== source.id || service.enabled === false || !deployment) {
    throw new ValidationError("The shared source service is no longer available.");
  }
  await withServiceRuntime(source, deployment, runtime, async runtime => {
    if (!runtime.joinServiceGroupContainers) throw new ValidationError("Private service sharing requires a Docker server.");
    const tracked = await containerIdForService(deployment, service);
    const containerId = await liveContainerIdWithRuntime(runtime, {
      service, projectId: source.id, slug: source.slug, tracked,
    });
    if (!containerId) throw new ValidationError(`Start ${service.name} before connecting it to another project.`);
    await runtime.joinServiceGroupContainers(sharedServiceAlias(serviceId), [
      { containerId, aliases: [sharedServiceAlias(serviceId)] },
    ], { strict: true });
  });
}

/** Unlinking revokes network access too, including adopted consumer containers. */
export async function disconnectSharedServiceNetwork(
  source: Project,
  target: Project,
  serviceId: string,
  removedLinkId: string,
): Promise<void> {
  const sourceDeployment = source.activeDeploymentId
    ? await findActiveDeployment(source) : null;
  if (!sourceDeployment) return;
  await withServiceRuntime(source, sourceDeployment, undefined, async runtime => {
    if (!runtime.leaveServiceGroupContainers) return;
    const links = (await repos.projectConnection.listBySourceService(serviceId))
      .filter(link => link.id !== removedLinkId);
    const targetLinks = links.filter(link => usesPrivateNetwork(link) && link.targetProjectId === target.id);
    if (targetLinks.length > 0) return;
    const ids = new Set(await runtime.listProjectContainerIds?.(target.id) ?? []);
    if (target.activeDeploymentId) {
      for (const row of await listActiveServiceDeployments(target)) {
        if (row.containerId) ids.add(row.containerId);
      }
    }
    if (!links.some(usesPrivateNetwork)) {
      const service = await repos.service.findById(serviceId);
      if (service) {
        const containerId = await containerIdForService(sourceDeployment, service);
        if (containerId) ids.add(containerId);
      }
    }
    await runtime.leaveServiceGroupContainers(sharedServiceAlias(serviceId), [...ids]);
  });
}

/** Reuse a deploy's runtime when supplied; release SSH bridges owned by this call. */
async function withServiceRuntime<T>(
  source: Project,
  deployment: Deployment,
  runtime: RuntimeAdapter | undefined,
  use: (runtime: RuntimeAdapter) => Promise<T>,
): Promise<T> {
  if (runtime) return use(runtime);
  const { platform } = await resolveServicePlatform(source, deployment);
  try { return await use(platform.runtime); }
  finally { disposePlatform(platform); }
}
