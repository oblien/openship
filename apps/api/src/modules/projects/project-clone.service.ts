/**
 * Duplicate a project this instance owns — the record half of "copy this stack onto another
 * server".
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
 */

import { slugify, NotFoundError } from "@repo/core";
import { repos, type Project } from "@repo/db";

import type { AdoptResult } from "../migration/migrate.service";
import type { DiscoveredService } from "../migration/docker-reconcile";
import { assertProjectQuota, uniqueProjectSlug } from "./project-crud.service";

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
  // Lifecycle flags: a copy of a paused or half-deleted project starts clean and running.
  "deletedAt",
  "deletionInProgress",
  "disabledAt",
  // Detected from the live site; the copy has no site yet, so copying these would show the
  // original's icon next to a project that has never served a request.
  "favicon",
  "faviconCheckedAt",
  // Routing that names specific hostnames. The copy starts with no domains (the confirm dialog
  // promises exactly this) — the originals stay with the project still serving them.
  "compositeRoutes",
  // A server-hosted copy is not a cloud project, whatever the source was.
  "cloudWorkspaceId",
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

  // Before anything is written: a duplicate is a new project and counts against the cap like
  // any other. Checked here rather than inside the transaction so the operator gets the plan
  // guard's own message instead of a rolled-back write.
  await assertProjectQuota(input.organizationId);

  const desiredName = input.name?.trim() || `${source.name} copy`;
  const slug = await uniqueProjectSlug(input.organizationId, slugify(desiredName));

  const sourceServices = await repos.service.listByProject(source.id);
  // Discovered services are keyed by name here (not container id) because they have already
  // been narrowed to THIS project's containers upstream — inside one project a service name is
  // unique, which is exactly the condition that makes a name match safe.
  const discoveredByName = new Map(input.chosen.map((s) => [s.name, s]));
  const cloning = sourceServices.filter((row) => discoveredByName.has(row.name));

  if (cloning.length === 0) {
    // Nothing to build the copy out of. Reached only if the row/container sets disagree, which
    // the workload resolver should have refused first — so say what is wrong rather than
    // creating an empty project.
    throw new NotFoundError(
      "Services to duplicate",
      `${source.id} (no service rows matched the running containers)`,
    );
  }

  const cloningIds = new Set(cloning.map((row) => row.id));
  const sourceEnv = await repos.project.listEnvVars(source.id);

  const { project: created } = await repos.project.createProjectWithRecords({
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
      } as Parameters<typeof repos.project.createProjectWithRecords>[0]["services"][number]["row"],
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

  return {
    project: created,
    projectId: created.id,
    slug: created.slug,
    // TRUE — and load-bearing. The orchestrator's rollback tears down the project it created,
    // which for a duplicate is exactly right: a failed copy should leave nothing behind. (For a
    // MOVE the same field must be false, or rollback would delete the operator's real project.)
    created: true,
    adopted: cloning.map((row) => row.name),
    // Identity: the rows carry the source's own names, so nothing is renamed.
    renames: {},
    rowNameByDiscovered: {},
    // Reuse the image running right now for every copied service. Our tags exist on the source
    // host and in no registry, so without this the target's first deploy would try to pull one.
    handover: Object.fromEntries(
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
