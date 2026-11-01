/**
 * Periodic reconcile sweep.
 *
 * Deployments left `reconciling` by a connection-loss deploy are settled here
 * once their host is reachable again — the safety net for the on-load trigger
 * (a project nobody opens still gets reconciled). Scheduled as the
 * "deployments:reconcile" system job (every 10 min) via the jobs module.
 */

import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { reconcileDeployment } from "@repo/platform/engine/modules/deployments/reconcile.service";

export async function runReconcileSweep(): Promise<{ finalized: number; pending: number }> {
  const { runRoleHandoverRecovery } = await import("./role-handover");
  const roles = await runRoleHandoverRecovery();
  const deps = await repos.deployment.listByStatus("reconciling");
  let finalized = roles.recovered;
  let pending = roles.pending;
  for (const dep of deps) {
    try {
      const outcome = await reconcileDeployment(dep.id);
      if (outcome === "finalized") finalized++;
      else pending++;
    } catch (err) {
      pending++;
      errorDiagnostics.error("platform/engine/modules/deployments/reconcile-schedule", `[reconcile] ${dep.id} failed`, err);
    }
  }
  return { finalized, pending };
}
