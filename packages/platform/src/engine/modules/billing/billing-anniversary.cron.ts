/**
 * Oblien renews subscriptions and resets usage. This job only repairs the local
 * display/permission mirror when webhook delivery is delayed or missed. Explicit
 * complimentary grants renew their Mode A allowance through the same reconciler.
 */
import { and, asc, db, gt, isNotNull, schema } from "@repo/db";
import { env } from "../../config/env";
import { getJobRunner } from "../../lib/job-runner/index";
import { reconcileOblienEntitlement } from "./billing-oblien-quota";

const RECONCILE_BATCH = 200;
let cursor: string | undefined;

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
  const orgs = await db.select({ id: schema.organization.id }).from(schema.organization)
    .where(and(
      isNotNull(schema.organization.oblienNamespace),
      cursor ? gt(schema.organization.id, cursor) : undefined,
    ))
    .orderBy(asc(schema.organization.id))
    .limit(RECONCILE_BATCH);
  for (const org of orgs) {
    stats.scanned += 1;
    const drift = await reconcileOblienEntitlement(org.id);
    if (!drift) { stats.errors += 1; continue; }
    if (drift.quotaMissing) stats.uncapped += 1;
    if (drift.statusNow !== drift.statusWas) stats.statusFixed += 1;
    if (drift.changed) stats.corrected += 1;
  }
  // Keyset pagination reaches every customer, unlike repeatedly reading LIMIT 200.
  cursor = orgs.length === RECONCILE_BATCH ? orgs[orgs.length - 1]!.id : undefined;
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
        console.error("[billing-reconcile] sweep failed", error);
      }
    },
  });
}

export const scheduleBillingReset = scheduleBillingAnniversary;
