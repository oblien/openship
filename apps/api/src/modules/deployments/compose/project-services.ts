/**
 * Project service-shape helpers.
 *
 * Compose is only one way to populate project services. The deployment shape
 * is owned by the project: if it has saved services, or the current deploy
 * request includes parsed services, it uses the service pipeline.
 *
 * The DB `service` row is the canonical shape - compose rows have null
 * monorepo fields, monorepo rows have null compose-source fields. This file
 * projects those rows into the wider `DeployableService` shape the pipeline
 * consumes, without re-asserting that invariant on every field.
 */

import { repos, type Project, type Service } from "@repo/db";
import { getProjectType, type StackId } from "@repo/core";
import { serviceKind, type DeployableService } from "../../../lib/deployable-service";
export { serviceKind } from "../../../lib/deployable-service";

export function isMultiServiceProject(project: Pick<Project, "framework">): boolean {
  const framework = project.framework as StackId | undefined;
  if (!framework) return false;

  try {
    return getProjectType(framework) === "services";
  } catch {
    return framework === "docker-compose";
  }
}

/** Deployable rows - both compose services AND monorepo sub-apps.
 *  Both kinds travel through the same compose pipeline (kind-discriminated
 *  build/deploy translators) and fan out via the unified pipeline. */
export async function listProjectComposeServices(projectId: string): Promise<Service[]> {
  const all = await repos.service.listByProject(projectId);
  return all.filter((s) => s.kind === "compose" || s.kind === "monorepo");
}

/** Monorepo sub-apps only. */
export async function listProjectMonorepoApps(projectId: string): Promise<Service[]> {
  const all = await repos.service.listByProject(projectId);
  return all.filter((s) => s.kind === "monorepo");
}

/**
 * Project a row of the canonical `service` table into the pipeline's
 * `DeployableService` shape.
 *
 * No `isMonorepo ?` per-field conditionals: the DB invariant is that compose
 * rows have null monorepo fields and vice versa, so a `?? undefined` is all
 * we need. Treating the row as the source of truth means a future "set
 * installCommand on a compose row" bug would surface immediately instead of
 * being silently masked here.
 */
export function projectServicesToDeployableServices(
  services: Service[],
  everDeployedByServiceId?: Map<string, boolean>,
): DeployableService[] {
  return services.map((s): DeployableService => ({
    kind: serviceKind(s),
    everDeployed: everDeployedByServiceId?.get(s.id),
    enabled: s.enabled,
    name: s.name,
    image: s.image ?? undefined,
    build: s.build ?? undefined,
    dockerfile: s.dockerfile ?? undefined,
    ports: (s.ports as string[] | null) ?? [],
    dependsOn: (s.dependsOn as string[] | null) ?? [],
    environment: (s.environment as Record<string, string> | null) ?? {},
    volumes: (s.volumes as string[] | null) ?? [],
    command: s.command ?? undefined,
    commandArgv: (s.commandArgv as string[] | null) ?? null, // #332
    restart: s.restart ?? undefined,
    exposed: s.exposed,
    exposedPort: s.exposedPort ?? undefined,
    domain: s.domain ?? undefined,
    customDomain: s.customDomain ?? undefined,
    domainType: s.domainType === "custom" ? "custom" : "free",
    publicEndpoints: (s.publicEndpoints as DeployableService["publicEndpoints"]) ?? undefined,
    rootDirectory: s.rootDirectory ?? undefined,
    installCommand: s.installCommand ?? undefined,
    buildCommand: s.buildCommand ?? undefined,
    startCommand: s.startCommand ?? undefined,
    outputDirectory: s.outputDirectory ?? undefined,
    framework: s.framework ?? undefined,
    packageManager: s.packageManager ?? undefined,
    buildImage: s.buildImage ?? undefined,
  }));
}

export async function resolveProjectServicePreflightServices(
  projectId: string,
  requestServices?: DeployableService[] | null,
): Promise<DeployableService[]> {
  if (requestServices?.length) return requestServices;
  const services = await listProjectComposeServices(projectId);
  // One round trip for "has this service EVER produced a service_deployment
  // row" — distinguishes a saved row nobody has ever deployed (eligible for
  // the dead-row preflight carve-out) from a fresh row about to be deployed
  // for the first time (still an unknown until it either succeeds or fails).
  const latestByService = await repos.serviceDeployment.latestByProject(projectId);
  const everDeployedByServiceId = new Map(
    services.map((s) => [s.id, latestByService.has(s.id)]),
  );
  return projectServicesToDeployableServices(
    services.filter((service) => service.enabled),
    everDeployedByServiceId,
  );
}

export async function shouldUseProjectServicePipeline(
  project: Project,
  requestServices?: DeployableService[] | null,
): Promise<boolean> {
  if (requestServices?.length) return true;
  // Both compose AND monorepo rows trigger the unified pipeline.
  if ((await listProjectComposeServices(project.id)).length > 0) return true;

  // Fallback for compose projects that don't have synced service rows.
  return isMultiServiceProject(project);
}

