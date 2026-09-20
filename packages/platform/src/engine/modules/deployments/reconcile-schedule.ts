/**
 * Periodic reconcile sweep.
 *
 * Deployments left `reconciling` by a connection-loss deploy are settled here
 * once their host is reachable again — the safety net for the on-load trigger
 * (a project nobody opens still gets reconciled). Scheduled as the
 * "deployments:reconcile" system job (every 10 min) via the jobs module.
 */

import { repos } from "@repo/db";
import { reconcileDeployment } from "@repo/platform/engine/modules/deployments/reconcile.service";

export async function runReconcileSweep(): Promise<{ finalized: number; pending: number }> {
  const deps = await repos.deployment.listByStatus("reconciling");
  let finalized = 0;
  let pending = 0;
  for (const dep of deps) {
    try {
      const outcome = await reconcileDeployment(dep.id);
      if (outcome === "finalized") finalized++;
      else pending++;
    } catch (err) {
      pending++;
      console.error(`[reconcile] ${dep.id} failed`, err);
    }
  }
  return { finalized, pending };
}
