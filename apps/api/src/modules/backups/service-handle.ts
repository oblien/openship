/**
 * @module service-handle
 *
 * The `ServiceHandle` a backup or a restore runs against.
 *
 * One definition because the two directions have to agree on the env a producer
 * sees, and not loosely: `pg_dump -U $POSTGRES_USER` writes the dump and
 * `psql -U $POSTGRES_USER` reads it back, so if either side resolved
 * `POSTGRES_USER` from a different source — or merged the sources in a different
 * order — a restore would authenticate as someone the dump was never taken as.
 * Both orchestrators spelled the resolution out separately, with the comment
 * explaining the precedence on the backup copy only.
 *
 * The container id stays with the caller: a backup targets the live container or
 * nothing, while a restore is allowed one narrow fallback
 * (`deploymentManagedContainerId`). That asymmetry is deliberate, so it is a
 * parameter rather than a branch in here.
 */

import { repos, type Service } from "@repo/db";
import type { BackupExecutor, ServiceHandle } from "@repo/adapters";
import { decryptEnvMap } from "../../lib/encryption";

/**
 * Env as a producer will see it, decrypted at this boundary so no producer has to
 * hold a key.
 *
 * The layering MIRRORS the deploy path's `mergeServiceDeployEnv`
 * (project → inline → service), and that is the whole requirement: the container
 * being dumped was started by that function, so any other order means
 * `pg_dump -U $POSTGRES_USER -d $POSTGRES_DB` is aimed somewhere the running
 * database is not.
 *
 * It previously called `listEnvVars(projectId)` with NEITHER an environment NOR a
 * serviceId. `envVarScope` only narrows on the arguments it is given, so that
 * returned EVERY env_var row in the project — every other service's rows and every
 * environment's rows — flattened with no ordering, and then spread ABOVE the
 * service's own inline compose env. So in a normal compose project where the app
 * service also carries `POSTGRES_DB` (it needs it, to build its DSN), the postgres
 * service was dumped using the APP's value; with `production` and `preview` rows for
 * one key, whichever the query happened to return last won. Both produce a green run
 * whose artifact is a dump of the wrong database — and the wrong name is recorded
 * into the manifest, so the restore agrees with the mistake.
 *
 * A failed env-var read degrades to the compose defaults rather than aborting — the
 * behaviour both call sites already had. It does mean "no user-set variables" and
 * "could not read them" produce the same map.
 */
async function resolveServiceEnv(
  serviceRow: Service,
  environment: string,
): Promise<Record<string, string>> {
  const inline = (serviceRow.environment as Record<string, string> | null) ?? {};
  const [projectLevel, serviceScoped] = await Promise.all([
    // serviceId === null is what pins this to project-level rows only; omitting it
    // is what made the query return everything.
    repos.project.getEnvMap(serviceRow.projectId, environment, null).catch(() => ({})),
    repos.project.getEnvMap(serviceRow.projectId, environment, serviceRow.id).catch(() => ({})),
  ]);
  return {
    ...decryptEnvMap(projectLevel),
    ...inline,
    ...decryptEnvMap(serviceScoped),
  };
}

/** The handle for a real service row, given its project slug and an
 *  already-resolved container id. */
export async function serviceHandleFor(
  serviceRow: Service,
  target: {
    projectSlug: string;
    containerId: string | null;
    /** Omit when the caller did not look — see `ServiceHandle.containerRunning`.
     *  Absent means UNKNOWN, which producers must read as "proceed", never as
     *  "stopped". */
    containerRunning?: boolean | null;
    /**
     * The deployment's environment, so env_var rows are read at the scope the
     * running container was built from. Defaults to `production`, which is the
     * `env_var.environment` column default — i.e. where a row lands when nothing
     * chose otherwise.
     */
    environment?: string;
  },
): Promise<ServiceHandle> {
  return {
    id: serviceRow.id,
    projectId: serviceRow.projectId,
    name: serviceRow.name,
    image: serviceRow.image,
    env: await resolveServiceEnv(serviceRow, target.environment ?? "production"),
    volumes: (serviceRow.volumes as string[] | null) ?? [],
    containerId: target.containerId,
    containerRunning: target.containerRunning ?? null,
    projectSlug: target.projectSlug,
    namespaceVolumes: serviceRow.namespaceVolumes,
  };
}

/**
 * Fill in env the DB never recorded, from the container that is actually running.
 *
 * The precedence is deliberate and it is the LOWEST: container env is the base,
 * everything `serviceHandleFor` resolved wins over it. Reasoning — an operator's
 * env-var row is a statement of intent that a redeploy will apply, so it must not
 * be shadowed by whatever the currently-running container happens to have been
 * started with (a value they have since changed). But where the DB says nothing at
 * all, the container is the only witness, and today that silence is read as "this
 * isn't a database", which is how the control plane's own postgres got a green
 * backup that captured nothing (#611).
 *
 * Applied to both capture and restore, from this one place, for the reason this
 * module exists: `pg_dump -U $POSTGRES_USER` and `pg_restore -U $POSTGRES_USER`
 * have to resolve that variable identically or the restore authenticates as
 * someone the dump was never taken as.
 *
 * Best-effort by construction — an executor without `readContainerEnv` (bare,
 * cloud) or a failed inspect returns the handle untouched.
 */
export async function withContainerEnv(
  handle: ServiceHandle,
  executor: BackupExecutor,
): Promise<ServiceHandle> {
  if (!executor.readContainerEnv || !handle.containerId) return handle;
  const fromContainer = await executor.readContainerEnv(handle).catch(() => ({}));
  if (Object.keys(fromContainer).length === 0) return handle;
  return { ...handle, env: { ...fromContainer, ...handle.env } };
}
