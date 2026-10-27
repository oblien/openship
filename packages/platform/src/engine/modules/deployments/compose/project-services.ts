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

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos, type Project, type Service } from "@repo/db";
import { getProjectType, composeNamespaceDependencies, type ComposeAdvanced, type StackId } from "@repo/core";
import { hasSourceBuildRecipe, serviceKind, type DeployableService } from "../../../lib/deployable-service";
import { resolveServicePublicEndpoints } from "../../../lib/public-endpoints";
import { isMaterializedAppRow } from "../../services/materialized-app-row";
import { replaysFrozenDeployment } from "../deployment-artifacts";
export { serviceKind } from "../../../lib/deployable-service";

export function isMultiServiceProject(
  project: Pick<Project, "framework"> & { composePath?: string | null },
): boolean {
  // A declared compose file is authoritative project shape, even for a legacy
  // row whose framework still says plain "docker" and has no service rows yet.
  // This is also the bootstrap signal reconcileComposeSource uses to create the
  // first rows; without it composePath only affected scanning, not deployment.
  if (project.composePath?.trim()) return true;
  const framework = project.framework as StackId | undefined;
  if (!framework) return false;

  try {
    return getProjectType(framework) === "services";
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/compose/project-services");
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
  return services.map(
    (s): DeployableService => ({
      kind: serviceKind(s),
      everDeployed: everDeployedByServiceId?.get(s.id),
      enabled: s.enabled,
      name: s.name,
      image: s.image ?? undefined,
      build: s.build ?? undefined,
      dockerfile: s.dockerfile ?? undefined,
      buildArgs: (s.buildArgs as Record<string, string | null> | null) ?? undefined,
      ports: (s.ports as string[] | null) ?? [],
      dependsOn: (s.dependsOn as string[] | null) ?? [],
      environment: (s.environment as Record<string, string> | null) ?? {},
      volumes: (s.volumes as string[] | null) ?? [],
      command: s.command ?? undefined,
      commandArgv: (s.commandArgv as string[] | null) ?? null, // #332
      restart: s.restart ?? undefined,
      // Carried so the frozen `meta.composeServices` snapshot can replay a
      // release's healthcheck / readiness / generated files / resource caps /
      // east-west alias. Dropping it meant a rollback re-ran the release with
      // those stripped.
      advanced: (s.advanced as ComposeAdvanced | null) ?? undefined,
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
    }),
  );
}

/**
 * "Was this service added AFTER the release this deploy is restoring?"
 *
 * A rollback restores one release; it says nothing about services created since.
 * Their rows now survive the deploy-time sync (`removeMissing: false`), so both
 * the build phase and the deploy phase have to skip them explicitly — otherwise
 * a source-built newer service is rebuilt at a commit that may not contain it,
 * and its running container is replaced by a rollback that never meant to touch it.
 *
 * Derived from `dep` rather than an option so neither phase can forget it, and
 * keyed by NAME because the frozen `meta.composeServices` is a config snapshot
 * with no service ids. Always false when this isn't a rollback, and false when
 * the snapshot carries no service list at all — carrying everything forward
 * would make such a rollback a silent no-op.
 */
export function newerThanRestoredRelease(dep: {
  trigger?: string | null;
  meta?: unknown;
}): (service: { name: string }) => boolean {
  if (!replaysFrozenDeployment(dep)) return () => false;
  const frozen = (dep.meta as { composeServices?: Array<{ name?: string }> } | null)
    ?.composeServices;
  const names = new Set((frozen ?? []).map((s) => s.name).filter((n): n is string => !!n));
  if (names.size === 0) return () => false;
  return (service) => !names.has(service.name);
}

export async function resolveProjectServicePreflightServices(
  projectId: string,
  requestServices?: DeployableService[] | null,
  savedServices?: Service[],
): Promise<DeployableService[]> {
  if (requestServices?.length) return requestServices;
  const services = savedServices ?? (await listProjectComposeServices(projectId));
  // One round trip for "has this service EVER produced a service_deployment
  // row" — distinguishes a saved row nobody has ever deployed (eligible for
  // the dead-row preflight carve-out) from a fresh row about to be deployed
  // for the first time (still an unknown until it either succeeds or fails).
  const latestByService = await repos.serviceDeployment.latestByProject(projectId);
  const everDeployedByServiceId = new Map(services.map((s) => [s.id, latestByService.has(s.id)]));
  return projectServicesToDeployableServices(
    services.filter((service) => service.enabled),
    everDeployedByServiceId,
  );
}

export async function shouldUseProjectServicePipeline(
  project: Project,
  requestServices?: DeployableService[] | null,
  savedServices?: Service[],
): Promise<boolean> {
  if (requestServices?.length) return true;
  // Both compose AND monorepo rows trigger the unified pipeline, but disabled
  // rows are retained configuration rather than deployable topology. Counting
  // them here routes a single-app project with only disabled sidecars into an
  // empty service deploy (notably after switching it to a release image).
  const services = savedServices ?? (await listProjectComposeServices(project.id));
  if (services.some((service) => service.enabled !== false)) {
    return true;
  }

  // Fallback for compose projects that don't have synced service rows.
  return isMultiServiceProject(project);
}

/** One inherited source app with optional image-only infrastructure, not general Compose.
 * Overrides on the app row belong to the multi-app pipeline and are never lost
 * by treating that row as its parent project's single app. */
export function primaryAppWithInfrastructure(
  project: Pick<
    Project,
    | "slug"
    | "rootDirectory"
    | "framework"
    | "composePath"
    | "buildCommand"
    | "startCommand"
    | "port"
    | "compositeRoutes"
  >,
  services: Service[],
) {
  if (
    (isMultiServiceProject(project) && project.framework !== "docker") ||
    project.composePath?.trim() ||
    project.compositeRoutes?.length ||
    !hasSourceBuildRecipe(project)
  )
    return null;
  const enabled = services.filter((service) => service.enabled);
  const apps = enabled.filter((service) => serviceKind(service) === "monorepo");
  if (apps.length !== 1) return null;
  const app = apps[0]!;
  if (
    !isMaterializedAppRow(project, app) ||
    (app.rootDirectory ?? ".") !== (project.rootDirectory ?? ".") ||
    Object.keys(app.buildArgs ?? {}).length ||
    app.namespaceVolumes === false ||
    app.alwaysRebuildGlobs?.length ||
    (app.restart && !["unless-stopped", "always"].includes(app.restart)) ||
    app.ports?.length ||
    (app.exposedPort && Number(app.exposedPort) !== project.port) ||
    resolveServicePublicEndpoints(app).some(
      (endpoint) => endpoint.port != null && endpoint.port !== project.port,
    ) ||
    Object.keys(app.environment ?? {}).length ||
    app.volumes?.length ||
    Object.keys(app.advanced ?? {}).length ||
    app.command ||
    app.commandArgv?.length ||
    app.buildImage ||
    app.packageManager
  )
    return null;
  const infrastructure = enabled.filter((service) => service.id !== app.id);
  if (
    infrastructure.some(
      (service) =>
        serviceKind(service) !== "compose" ||
        !service.image ||
        service.exposed ||
        service.build ||
        service.dockerfile ||
        service.advanced?.build ||
        service.dependsOn?.includes(app.name) ||
        composeNamespaceDependencies(service.advanced).includes(app.name),
    )
  )
    return null;
  if (app.dependsOn?.some((name) => !infrastructure.some((service) => service.name === name)))
    return null;
  return { app, infrastructure };
}
