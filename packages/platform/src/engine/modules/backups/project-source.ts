import { resolveProjectVolumes, ValidationError } from "@repo/core";
import { repos, type Project, type Service } from "@repo/db";
import type { ServiceHandle } from "@repo/adapters";
import { findActiveDeployment } from "../../lib/active-deployment";
import { COMPOSE_SENTINEL, isArtifactRef, usableRef } from "../../lib/container-ref";
import { decryptEnvMap } from "../../lib/encryption";
import { assertResourceInOrg } from "../../lib/resource-access";

/** A standalone app is a backup unit without becoming a deployment service row.
 * Disabled services still count: never reinterpret a service stack as its app. */
export function projectBackupVolumes(project: Project, services: Service[]): string[] {
  if (services.length || project.composePath?.trim() || project.appTemplateId) return [];
  return resolveProjectVolumes(project.volumes, project.framework);
}

/** Capture and restore resolve the same project-owned app and volume names.
 * Only runs explicitly recorded as sourceKind=project may use this path;
 * a deleted service's null foreign key is never a project-app fallback. */
export async function resolveProjectBackupSource(projectId: string | null, organizationId: string) {
  if (!projectId) throw new ValidationError("The backup's project no longer exists.");
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  if (project.deletedAt || project.deletionInProgress)
    throw new ValidationError("The backup project is being deleted.");
  const services = await repos.service.listByProject(project.id);
  const volumes = projectBackupVolumes(project, services);
  if (!volumes.length)
    throw new ValidationError(
      "This backup targets a standalone app with persistent storage. Its configuration has changed; review the backup target.",
    );
  const deployment = await findActiveDeployment(project);
  if (!deployment)
    throw new ValidationError("Deploy the app before backing up or restoring its storage.");
  const meta = deployment.meta as { composeServices?: unknown[] } | null;
  if (
    meta?.composeServices?.length ||
    deployment.containerId === COMPOSE_SENTINEL ||
    isArtifactRef(deployment.containerId)
  )
    throw new ValidationError("The active deployment is not a standalone application.");

  const handle: ServiceHandle = {
    id: project.id,
    projectId: project.id,
    name: project.slug,
    image: usableRef(deployment.imageRef),
    env: decryptEnvMap(await repos.project.getEnvMap(project.id, deployment.environment, null)),
    volumes,
    containerId: usableRef(deployment.containerId),
    containerRunning: null,
    projectSlug: project.slug,
    namespaceVolumes: true,
  };
  return { project, deployment, handle };
}
