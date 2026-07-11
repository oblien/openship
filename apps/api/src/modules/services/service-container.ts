import { repos } from "@repo/db";

/**
 * The live container id for one service within a deployment — the SINGLE
 * source of truth shared by the service terminal, backups, and restores.
 *
 * Authoritative source: the per-service `service_deployment` row (keyed by
 * deployment + service). Falls back to the compose meta matched by name for
 * older deploys that predate per-service rows.
 *
 * It NEVER falls back to `deployment.containerId`: for a compose deploy that is
 * the PRIMARY service's container (e.g. postgres), so a miss there would
 * silently resolve the WRONG container — wrong shell, wrong backup/restore
 * target. Returns null when the service has no container yet (still deploying).
 */
export async function containerIdForService(
  dep: { id: string; meta?: unknown },
  service: { id: string; name: string },
): Promise<string | null> {
  const sdRows = await repos.service.listByDeployment(dep.id);
  const sdRow = sdRows.find((r) => r.serviceId === service.id);
  const meta = (dep.meta ?? {}) as {
    composeServices?: Array<{ name: string; containerId?: string }>;
  };
  return (
    sdRow?.containerId ??
    meta.composeServices?.find((s) => s.name === service.name)?.containerId ??
    null
  );
}
