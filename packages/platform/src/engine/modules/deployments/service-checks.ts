import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { isServiceSuccessStatus, isServiceFailureStatus } from "@repo/core";

// Runtime service fan-out and status rollup. GitHub reporting is owned by the
// durable deployment-checks reconciler, which observes every terminal path.
/**
 * Pre-create `service_deployment` rows for SKIPPED services.
 *
 * For services in `targetServiceIds`, the compose pipeline creates
 * its own per-service rows during deploy (status patches reflect
 * build/deploy progress). For services NOT in the target list — i.e.
 * intentionally unchanged — the compose pipeline never runs, so this
 * helper inserts the `skipped` row up front. That keeps the fan-out
 * record on the deployment complete from the moment building starts.
 *
 * When `forceAll=true` or no target list is given, every enabled
 * service is considered targeted; we return without inserting.
 *
 * Returns ALL services (targeted + skipped) keyed by service id so
 * the caller can inspect service targeting.
 */
export async function preCreateServiceDeployments(
  deploymentId: string,
  projectId: string,
  opts: {
    targetServiceIds?: string[];
    forceAll: boolean;
  },
): Promise<Map<string, { id: string | null; serviceId: string; serviceName: string; targeted: boolean }>> {
  const services = await repos.service.listByProject(projectId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/service-checks"); return []; });
  const enabled = services.filter((s) => s.enabled);
  const map = new Map<string, { id: string | null; serviceId: string; serviceName: string; targeted: boolean }>();
  if (enabled.length === 0) return map;

  const targetSet = opts.targetServiceIds && opts.targetServiceIds.length > 0
    ? new Set(opts.targetServiceIds)
    : null;

  // Capture targeted and skipped services before the compose pipeline runs.
  for (const svc of enabled) {
    const targeted = opts.forceAll || !targetSet || targetSet.has(svc.id);
    map.set(svc.id, {
      id: null,
      serviceId: svc.id,
      serviceName: svc.name,
      targeted,
    });
  }

  // Only insert SKIPPED rows here — targeted rows are created by the
  // downstream compose deploy path, which still owns its own writes.
  const skippedRows = enabled
    .filter((svc) => {
      const entry = map.get(svc.id);
      return entry ? !entry.targeted : false;
    })
    .map((svc) => ({
      deploymentId,
      serviceId: svc.id,
      serviceName: svc.name,
      status: "skipped" as const,
      reason: "unchanged",
      reasonSkipped: "unchanged",
    }));

  if (skippedRows.length > 0) {
    const inserted = await repos.serviceDeployment.bulkCreate(skippedRows);
    for (const row of inserted) {
      const existing = map.get(row.serviceId);
      if (existing) existing.id = row.id;
    }
  }

  return map;
}

/**
 * Roll up per-service results into the project-level deployment status.
 *
 *   - all `success` (or `skipped`)          → `ready`
 *   - mix of `success` and `failure`        → `partial_failure`
 *   - all `failure`                         → `failed`
 *
 * `skipped` rows are not counted as failures — they're intentional.
 *
 * Classification of the per-service status vocabulary lives in @repo/core
 * (service-status) so the rollup, the container-status endpoint, and the
 * dashboard badges share ONE definition of success/failure and can't drift.
 */
export function rollupDeploymentStatus(
  perService: Array<{ status: string }>,
): "ready" | "partial_failure" | "failed" {
  const real = perService.filter((s) => s.status !== "skipped");
  if (real.length === 0) return "ready";
  const successes = real.filter((s) => isServiceSuccessStatus(s.status)).length;
  const failures = real.filter((s) => isServiceFailureStatus(s.status)).length;
  if (failures === 0) return "ready";
  if (successes === 0) return "failed";
  return "partial_failure";
}
