/**
 * Oblien renews subscriptions and resets usage. This job only repairs the local
 * display/permission mirror when webhook delivery is delayed or missed. Explicit
 * complimentary grants renew their Mode A allowance through the same reconciler.
 */
import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { and, asc, db, gt, isNotNull, schema } from "@repo/db";
import { env } from "../../config/env";
import { getJobRunner } from "../../lib/job-runner/index";
import { reconcileOblienEntitlement } from "./billing-oblien-quota";

const RECONCILE_BATCH = 200;
let workspaceCursor: string | undefined;

export interface ReconcileStats {
  scanned: number;
  corrected: number;
  uncapped: number;
  statusFixed: number;
  errors: number;
}

export async function runEntitlementReconcile(): Promise<ReconcileStats> {
  const stats: ReconcileStats = { scanned: 0, corrected: 0, uncapped: 0, statusFixed: 0, errors: 0 };
  if (!env.CLOUD_MODE) return stats;
  // Each subscribed server is a billing owner. An organization-level pass would
  // select the same server twice, or fail when the customer owns several.
  // Keyset pagination reaches every server instead of repeating the first batch.
  const workspaces = await db.select().from(schema.cloudWorkspace).where(and(
    isNotNull(schema.cloudWorkspace.namespace),
    workspaceCursor ? gt(schema.cloudWorkspace.id, workspaceCursor) : undefined,
  )).orderBy(asc(schema.cloudWorkspace.id)).limit(RECONCILE_BATCH);
  for (const workspace of workspaces) {
    stats.scanned += 1;
    const drift = await reconcileOblienEntitlement(workspace.organizationId, workspace.id);
    if (!drift) { stats.errors += 1; continue; }
    if (drift.quotaMissing) stats.uncapped += 1;
    if (drift.changed) stats.corrected += 1;
    if (drift.statusNow !== drift.statusWas) stats.statusFixed += 1;
    try {
      const { requestPaidWorkspaceProvisioning } = await import("../cloud-workspaces/cloud-workspace.service");
      await requestPaidWorkspaceProvisioning(workspace.organizationId, workspace.id);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/billing/billing-anniversary.cron"); stats.errors += 1; }
  }
  workspaceCursor = workspaces.length === RECONCILE_BATCH ? workspaces[workspaces.length - 1]!.id : undefined;
  return stats;
}

export async function scheduleBillingAnniversary(): Promise<void> {
  if (!env.CLOUD_MODE) return;
  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    // Replaces the old recurring entry so a rollout cannot leave a reset job live.
    jobId: "billing:anniversary-reset",
    cronExpression: "*/5 * * * *",
    onTick: async () => {
      try {
        const stats = await runEntitlementReconcile();
        if (stats.corrected || stats.uncapped || stats.errors) console.log("[billing-reconcile]", stats);
      } catch (error) {
        errorDiagnostics.error("platform/engine/modules/billing/billing-anniversary.cron", "[billing-reconcile] sweep failed", error);
      }
    },
  });
  await runner.scheduleRecurring({
    jobId: "billing:actions-payments",
    cronExpression: "* * * * *",
    onTick: async () => {
      try {
        const { runActionsPaymentReconcile } = await import("../actions/billing-application");
        await runActionsPaymentReconcile();
      } catch (error) {
        errorDiagnostics.error("platform/engine/modules/billing/billing-anniversary.cron", "[actions-payment-reconcile] sweep failed", error);
      }
    },
  });
}

export const scheduleBillingReset = scheduleBillingAnniversary;
