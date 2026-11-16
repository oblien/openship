/**
 * Duplicate a project this instance owns — the record half of copying a stack onto
 * the same or another server.
 *
 * WHY THIS EXISTS AT ALL. A duplicate used to go through `adoptServerStack`, the same call that
 * takes a stranger's containers and reverse-engineers a project from them. Pointed at our own
 * project that is a strange thing to do: we hold the authoritative rows, and Docker inspection
 * cannot see most of them. Everything below survives a clone and did NOT survive an adopt —
 * framework and build settings, declared volumes vs. resolved mounts, per-service kind
 * (compose vs monorepo), route strategy, resource limits, rollback window, the compose
 * import/drift baselines, `alwaysRebuildGlobs`. An adopted duplicate booted and *looked* right,
 * then behaved differently on its next deploy, because it had been rebuilt from its own
 * containers rather than copied.
 *
 * SPREAD-MINUS-EXCLUSIONS, NOT AN ALLOWLIST. Every row is copied whole and then a named set of
 * fields is overridden or dropped. This is the opposite of the projection rule used for
 * outbound payloads (`readActiveMigration`), and deliberately so: there, a field added later
 * must not leak, so the safe default is to omit; here, a field added later must be COPIED, or
 * the clone silently degrades in a way nobody notices until a deploy behaves oddly. A test
 * pins that direction by adding an unknown column and asserting it lands.
 *
 * THE ONE HYBRID, AND WHY. `volumes` and `namespaceVolumes` come from the DISCOVERED runtime,
 * not from the source rows. The transfer streams each volume A→B *under the same name* — that
 * "no remap" property is what makes resume work — so the copy's deploy has to mount the name
 * the bytes actually landed under. A source row declares `pgdata:/var/lib/postgresql/data`,
 * while the running container mounts `openship-<sourceslug>-pgdata`; the clone has a NEW slug,
 * so re-namespacing would point it at `openship-<newslug>-pgdata`, which the transfer never
 * wrote. That copy would start with an empty database and report success. So: resolved names,
 * namespacing off — exactly what the adopt path did for cross-server, for exactly this reason.
 * Same-server copies are subsequently remapped by scopeImportedStorage into new
 * project-owned volumes before the transfer plan is built.
 */

import {
  slugify,
  NotFoundError,
  ValidationError,
  composeNamespaceDependencies,
  validateComposeNamespaces,
} from "@repo/core";
import { repos, type Project } from "@repo/db";

import type { AdoptResult } from "../migration/migrate.service";
import type { DiscoveredService } from "../migration/docker-reconcile";
import {
  assertProjectQuota,
  uniqueProjectSlug,
  withProjectCreationLock,
} from "./project-crud.service";
import { requireOrgServer } from "../../lib/server-target";

/**
 * Project columns the clone must NOT copy verbatim, each with the reason it is here. Anything
 * absent from this list is copied — see the module header.
 */
const PROJECT_FIELDS_NOT_CLONED = [
  // Identity, owned by the insert.
  "id",
  "createdAt",
  "updatedAt",
  // Its own name/slug (computed) and its own group. The group is not a preference: the DB's
  // `uq_project_app_environment_slug_active` is unique on (groupId, environmentSlug), and both
  // projects are `production` — sharing the source's group is a constraint violation, which is
  // the good outcome. Two projects in one group would also mean "two environments of one app",
  // which is not what a duplicate on another host is.
  "groupId",
  "name",
  "slug",
  // Where it runs. The whole point of the copy.
  "serverId",
  // Deployment state belongs to deploys that happened, and none have.
  "activeDeploymentId",
  "buildCacheReceipts",
  "previewSettings",
  "previewScannedAt",
  // A copy has never participated in the source project's Cloud transfer.
  "cloudPromotion",
  // Lifecycle flags: a copy of a paused or half-deleted project starts clean and running.
  "deletedAt",
  "deletionInProgress",
  "lifecycleOperation",
  "disabledAt",
  // Routing that names specific hostnames. The copy starts with no domains (the confirm dialog
  // promises exactly this) — the originals stay with the project still serving them.
  "compositeRoutes",
  // Placement comes from the chosen destination, never from the source.
  "workspaceId",
  "clusterId",
] as const;

/**
 * Service columns the clone must not copy verbatim.
 *
 * The routing block is dropped rather than reset field-by-field so that "the copy has no
 * domains" is one decision in one place. `containerId`/`deploymentId` are not here because they
 * live on `service_deployment`, not on `service`.
 */
const SERVICE_FIELDS_NOT_CLONED = [
  "id",
  "projectId",
  "createdAt",
  "updatedAt",
  // Public routing — see above.
  "exposed",
  "exposedPort",
  "domain",
  "customDomain",
  "domainType",
  "publicEndpoints",
  // The hybrid: taken from the running container instead. See the module header.
  "volumes",
  "namespaceVolumes",
] as const;

function omit(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const key of keys) delete out[key];
  return out;
}

/** `openship-x-pgdata:/var/lib/…` from a discovered mount, or null for an anonymous one. */
function mountToComposeString(v: { source?: string; target: string; rw?: boolean }): string | null {
  if (!v.source) return null;
  return `${v.source}:${v.target}${v.rw === false ? ":ro" : ""}`;
}

export interface CloneProjectResult extends AdoptResult {
  /** The new project row, so the caller can log/deploy without re-reading it. */
  project: Project;
}

/**
 * Copy `sourceProjectId` into a new project bound to `targetServerId`.
 *
 * Only the services present in `chosen` are cloned. That is what makes a SERVICE-scoped
 * duplicate ("copy just the database onto the new box") work without a second code path: the
 * caller narrows `chosen`, and a row whose container is not in it is not part of this copy —
 * its data is not being streamed either, so a row for it would describe a service that cannot
 * start.
 */
export async function cloneProjectToServer(input: {
  sourceProjectId: string;
  organizationId: string;
  targetServerId: string;
  /** The live services being copied, as the migration pipeline resolved them. */
  chosen: DiscoveredService[];
  /** Operator-chosen name. Defaults to `<source name> copy`, uniquified. */
  name?: string | null;
}): Promise<CloneProjectResult> {
  const source = await repos.project.findByIdInOrganization(
    input.sourceProjectId,
    input.organizationId,
  );
  if (!source) throw new NotFoundError("Project", input.sourceProjectId);
  const target = await requireOrgServer(input.targetServerId, input.organizationId);

  const desiredName = input.name?.trim() || `${source.name} copy`;

  const sourceServices = await repos.service.listByProject(source.id);
  // Discovered services are keyed by name here (not container id) because they have already
  // been narrowed to THIS project's containers upstream — inside one project a service name is
  // unique, which is exactly the condition that makes a name match safe.
  const discoveredByName = new Map(input.chosen.map((s) => [s.name, s]));
  const cloning = sourceServices.filter((row) => discoveredByName.has(row.name));

  const singleApp =
    sourceServices.length === 0 && input.chosen.length === 1 ? input.chosen[0] : undefined;
  if (cloning.length === 0 && !singleApp) {
    // Nothing to build the copy out of. Reached only if the row/container sets disagree, which
    // the workload resolver should have refused first — so say what is wrong rather than
    // creating an empty project.
    throw new NotFoundError(
      "Services to duplicate",
      `${source.id} (no service rows matched the running containers)`,
    );
  }
  if (!singleApp && cloning.length !== input.chosen.length) {
    throw new ValidationError(
      "The running services no longer match this project's configuration. Refresh the service list before duplicating. The original has not been stopped.",
    );
  }

  // Refuse before creating records or stopping anything. A narrowed copy cannot
  // share a namespace with a service left behind in the original project.
  for (const row of cloning) {
    validateComposeNamespaces(row.advanced);
    const dependencies = new Set([
      ...(row.dependsOn ?? []),
      ...Object.keys(row.advanced?.dependsOnConditions ?? {}),
      ...composeNamespaceDependencies(row.advanced),
    ]);
    const missing = [...dependencies].filter((name) => !discoveredByName.has(name));
    if (missing.length)
      throw new ValidationError(
        `Include ${missing.join(", ")} when duplicating ${row.name}; this service depends on them.`,
      );
  }
  if (singleApp?.volumes.length)
    throw new ValidationError(
      "Duplicating a single application with mounted data is not supported yet. The original has not been stopped.",
    );
  if (source.serverId === target.id) {
    const bind = input.chosen
      .flatMap((service) => service.volumes)
      .find((mount) => mount.type === "bind" || mount.source?.startsWith("/"));
    if (bind)
      throw new ValidationError(
        `This copy uses the host path ${bind.source}. Same-server duplication supports named Docker volumes; use a different server for host-mounted data. The original has not been stopped.`,
      );
  }

  const cloningIds = new Set(cloning.map((row) => row.id));
  const sourceEnv = await repos.project.listEnvVars(source.id);

  const { project: created } = await withProjectCreationLock(input.organizationId, async () => {
    await assertProjectQuota(input.organizationId, target.workspaceId, target.id);
    const slug = await uniqueProjectSlug(input.organizationId, slugify(desiredName));
    return repos.project.createProjectWithRecords({
      group: {
        organizationId: source.organizationId,
        name: desiredName,
        slug,
        // Git identity follows the project: a duplicate of a repo-backed project is still backed
        // by that repo, and its later redeploys should build from it.
        gitProvider: source.gitProvider ?? undefined,
        gitOwner: source.gitOwner ?? undefined,
        gitRepo: source.gitRepo ?? undefined,
        gitUrl: source.gitUrl ?? undefined,
      },
      project: {
        ...omit(source, PROJECT_FIELDS_NOT_CLONED),
        organizationId: source.organizationId,
        name: desiredName,
        slug,
        serverId: input.targetServerId,
        workspaceId: target.workspaceId,
        activeDeploymentId: null,
      } as Parameters<typeof repos.project.createProjectWithRecords>[0]["project"],
      services: cloning.map((row) => ({
        sourceId: row.id,
        row: {
          ...omit(row, SERVICE_FIELDS_NOT_CLONED),
          name: row.name,
          // The hybrid — resolved mount names, namespacing off. See the module header.
          volumes: (discoveredByName.get(row.name)?.volumes ?? [])
            .map(mountToComposeString)
            .filter((v): v is string => v !== null),
          namespaceVolumes: false,
          // A copy must never claim the original's published host ports. Retain
          // container ports; normal deployment allocates new loopback bindings.
          ...(source.serverId === target.id && {
            ports: (discoveredByName.get(row.name)?.ports ?? []).map((port) =>
              port.split(":").at(-1)!,
            ),
          }),
        } as Parameters<
          typeof repos.project.createProjectWithRecords
        >[0]["services"][number]["row"],
      })),
      // Verbatim, ciphertext included. The instance's encryption key is unchanged, so a secret
      // stays readable — and it MUST stay identical: the copy is handed a byte copy of the
      // source's volume, so a re-generated database password would lock it out of its own data.
      // Vars scoped to a service we are not cloning are dropped here (the repo refuses to
      // silently promote them to project-level).
      envVars: sourceEnv
        .filter((v) => !v.serviceId || cloningIds.has(v.serviceId))
        .map((v) => ({
          sourceServiceId: v.serviceId ?? null,
          key: v.key,
          value: v.value,
          environment: v.environment,
          isSecret: v.isSecret ?? false,
        })),
    });
  });

  return {
    project: created,
    projectId: created.id,
    slug: created.slug,
    // TRUE — and load-bearing. The orchestrator's rollback tears down the project it created,
    // which for a duplicate is exactly right: a failed copy should leave nothing behind. (For a
    // MOVE the same field must be false, or rollback would delete the operator's real project.)
    created: true,
    adopted: singleApp ? [singleApp.name] : cloning.map((row) => row.name),
    // Identity: the rows carry the source's own names, so nothing is renamed.
    renames: {},
    rowNameByDiscovered: {},
    // Reuse the image running right now for every copied service. Our tags exist on the source
    // host and in no registry, so without this the target's first deploy would try to pull one.
    handover: singleApp?.image
      ? { [singleApp.name]: singleApp.image }
      : Object.fromEntries(
          cloning
            .map((row) => [row.name, discoveredByName.get(row.name)?.image])
            .filter((pair): pair is [string, string] => Boolean(pair[1])),
        ),
  };
}

/** The exclusion lists ARE the contract, so the tests assert against these and not a copy. */
export const CLONE_EXCLUSIONS = {
  project: PROJECT_FIELDS_NOT_CLONED,
  service: SERVICE_FIELDS_NOT_CLONED,
} as const;
