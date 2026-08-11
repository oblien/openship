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
import type { ServiceHandle } from "@repo/adapters";
import { decryptEnvMap } from "../../lib/encryption";

/**
 * Env as a producer will see it, decrypted at this boundary so no producer has to
 * hold a key. Two sources:
 *   service.environment — plaintext defaults from compose
 *   env_var rows        — encrypted per-key (user-set)
 * Project env wins over service defaults.
 *
 * A failed env-var read degrades to the compose defaults rather than aborting —
 * the behaviour both call sites already had. It does mean "no user-set variables"
 * and "could not read them" produce the same map.
 */
async function resolveServiceEnv(serviceRow: Service): Promise<Record<string, string>> {
  const envFromService = (serviceRow.environment as Record<string, string> | null) ?? {};
  const envFromProjectEncrypted = await repos.project
    .listEnvVars(serviceRow.projectId)
    .then((vars) => {
      const out: Record<string, string> = {};
      for (const v of vars) out[v.key] = v.value;
      return out;
    })
    .catch(() => ({}));
  return { ...envFromService, ...decryptEnvMap(envFromProjectEncrypted) };
}

/** The handle for a real service row, given its project slug and an
 *  already-resolved container id. */
export async function serviceHandleFor(
  serviceRow: Service,
  target: { projectSlug: string; containerId: string | null },
): Promise<ServiceHandle> {
  return {
    id: serviceRow.id,
    projectId: serviceRow.projectId,
    name: serviceRow.name,
    image: serviceRow.image,
    env: await resolveServiceEnv(serviceRow),
    volumes: (serviceRow.volumes as string[] | null) ?? [],
    containerId: target.containerId,
    projectSlug: target.projectSlug,
    namespaceVolumes: serviceRow.namespaceVolumes,
  };
}
