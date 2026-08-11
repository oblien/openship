/**
 * Billing anniversary cron — Oblien-quota-resetting rollover.
 *
 * Replaces the legacy `billing-reset.cron` which minted local
 * credit_grant rows. The credit ledger is gone (see migration
 * 0011_remove_credit_ledger); Oblien now owns consumption and quota
 * enforcement. This cron is the openship-side bridge that re-arms each
 * org's Oblien quota at the boundary of every billing period:
 *
 *   1. Pick orgs where current_period_end < now() AND
 *      subscription_status NOT IN ('canceled'). The Stripe webhook is
 *      still the authoritative driver for paid orgs — this cron is the
 *      safety net for orgs whose webhook delivery lagged, plus the only
 *      mechanism for free-tier orgs (no Stripe subscription to fire a
 *      period-end webhook).
 *
 *   2. For each candidate, read the tier from organization.plan_tier_id,
 *      look up the tier definition from PLANS, and call the quota
 *      wrapper:
 *        a. namespaces.resetQuota(...)         → zero out quota_used
 *        b. namespaces.setQuota({ quotaLimit, … }) → re-arm the limit
 *           for the new period with `stop_workspaces` on overdraft.
 *      Both calls are idempotent on Oblien's side, so racing with a
 *      Stripe webhook handler that already ran them is harmless.
 *
 *   3. Advance organization.current_period_start/end by one calendar
 *      month. The advance is the natural idempotency key — once
 *      period_end is in the future, the org is skipped on subsequent
 *      ticks until the next rollover.
 *
 *   4. If the org carried a stale 'credit_exhausted' display status, flip
 *      it back to 'active' in the same UPDATE. We do NOT call Oblien to
 *      activate anything — Oblien's overdraft gate lifts itself once the
 *      fresh (zeroed) usage sits under the re-armed ceiling.
 *
 *   5. Emit a `billing.anniversary_reset` audit event with a
 *      before/after diff so operators can trace which orgs the cron
 *      touched.
 *
 * Idempotency: the period-end advance is the marker. If the Stripe
 * webhook beat us (it advances period_end via Stripe's reported
 * timestamps), the candidate query won't pick up the org. The quota
 * SDK calls themselves are also idempotent — setQuota is an
 * upsert-shape, resetQuota is a zero-set.
 *
 * Tier definitions with `monthlyCredits === null` (enterprise) are
 * skipped — those orgs are managed under contract, not the rollover
 * cron.
 *
 * Self-hosted no-op: master Oblien credentials only live on the SaaS
 * API, so the sweep exits early when CLOUD_MODE is false. Period
 * advances depend on Stripe in that path, which is also CLOUD_MODE
 * only — there's nothing for self-hosted to roll over.
 */

import { PLANS, type PlanTierId, safeErrorMessage } from "@repo/core";
import { and, db, eq, lt, notInArray, repos, schema } from "@repo/db";
import { env } from "../../config/env";
import { getJobRunner } from "../../lib/job-runner";
import { resetAndRegrant } from "./billing-oblien-quota";

const BILLING_ANNIVERSARY_JOB_ID = "billing:anniversary-reset";
// Hourly at minute 7 — keeps the legacy schedule so booted instances
// don't double-fire while migrating, and stays off the :00/:30 marks
// other jobs use.
const BILLING_ANNIVERSARY_CRON = "7 * * * *";

const SKIP_STATUSES = ["canceled"] as const;

/**
 * Oblien service key the quota applies to — surfaced only in the audit row
 * now; the actual reset+re-arm goes through the shared quota wrapper
 * (`billing-oblien-quota.resetAndRegrant`), which owns the milli→Oblien-credit
 * unit boundary + resource-limit re-apply. This cron no longer duplicates that
 * logic (and no longer suspends/activates — Oblien's overdraft action owns it).
 */
const QUOTA_SERVICE = "compute";

/**
 * Advance a Date by one calendar month. Handles month-end edge cases
 * (Jan 31 → Feb 28/29) the same way Stripe does — clamp to the last
 * day of the target month.
 */
function addOneMonth(d: Date): Date {
  const next = new Date(d.getTime());
  const originalDay = next.getUTCDate();
  next.setUTCMonth(next.getUTCMonth() + 1);
  // setUTCMonth overshoots when the original day doesn't exist in the
  // target month — e.g. setting Jan 31 → Feb 31 wraps to Mar 3.
  // Detect and clamp.
  if (next.getUTCDate() < originalDay) {
    next.setUTCDate(0); // last day of previous (target) month
  }
  return next;
}

interface ResetStats {
  candidates: number;
  reset: number;
  restored: number;
  skipped: number;
  errors: number;
}

/**
 * Single sweep — find candidate orgs and roll each one's period.
 * Returns aggregate counts for logging. Exported for tests and for
 * a future operator-facing "force-reset" admin endpoint.
 */
export async function runAnniversaryReset(): Promise<ResetStats> {
  const stats: ResetStats = {
    candidates: 0,
    reset: 0,
    restored: 0,
    skipped: 0,
    errors: 0,
  };

  const now = new Date();

  const candidates = await db
    .select({
      id: schema.organization.id,
      planTierId: schema.organization.planTierId,
      subscriptionStatus: schema.organization.subscriptionStatus,
      currentPeriodStart: schema.organization.currentPeriodStart,
      currentPeriodEnd: schema.organization.currentPeriodEnd,
      oblienNamespace: schema.organization.oblienNamespace,
    })
    .from(schema.organization)
    .where(
      and(
        lt(schema.organization.currentPeriodEnd, now),
        notInArray(schema.organization.subscriptionStatus, [...SKIP_STATUSES]),
      ),
    );

  stats.candidates = candidates.length;

  for (const org of candidates) {
    try {
      // The schema column is `text` typed as a free-form string; PLANS
      // is keyed by PlanTierId. Cast + verify the plan exists.
      const tierId = org.planTierId as PlanTierId;
      const tier = PLANS[tierId];
      if (!tier) {
        console.warn(
          `[billing-anniversary] org=${org.id} has unknown plan_tier_id=${org.planTierId} — skipping`,
        );
        stats.skipped += 1;
        continue;
      }

      // Enterprise tier (monthlyCredits === null) is custom — quota is
      // hand-set per contract, not by the rollover cron.
      if (tier.monthlyCredits === null) {
        stats.skipped += 1;
        continue;
      }

      // No Oblien namespace yet → nothing to push quota at. Still
      // advance the period so we don't keep picking the org up; the
      // first provisioning call will set the quota from scratch.
      if (!org.oblienNamespace) {
        const newPeriodStart = org.currentPeriodEnd ?? now;
        const newPeriodEnd = addOneMonth(newPeriodStart);
        await db
          .update(schema.organization)
          .set({
            currentPeriodStart: newPeriodStart,
            currentPeriodEnd: newPeriodEnd,
          })
          .where(eq(schema.organization.id, org.id));
        stats.skipped += 1;
        continue;
      }

      // Compute the next period window. Anchor on currentPeriodEnd if
      // present (preserves Stripe's exact billing-day alignment), else
      // anchor on `now` (first rollover after free-tier signup).
      const newPeriodStart = org.currentPeriodEnd ?? now;
      const newPeriodEnd = addOneMonth(newPeriodStart);

      // Claim BEFORE touching Oblien. If we crash between the Oblien
      // reset + the local period UPDATE, the next tick re-selects this
      // org as a candidate — without the claim we'd re-zero quota_used
      // for credits the user is already consuming under the new
      // period. The unique constraint on (org_id, period_start) makes
      // the claim atomic; a peer that won the race => skip.
      const grant = await repos.billingAnniversaryGrant.claim({
        organizationId: org.id,
        periodStart: newPeriodStart,
      });
      if (!grant.claimed) {
        console.log(
          `[billing-anniversary] org=${org.id} period_start=${newPeriodStart.toISOString()} already granted — skipping`,
        );
        stats.skipped += 1;
        continue;
      }

      // 1. Reset + re-arm the org's Oblien quota via the shared wrapper
      //    (resetQuota → setQuota with the unit boundary + resource limits).
      //    Oblien's overdraft gate clears itself once usage is back under the
      //    fresh ceiling — we do NOT activate the namespace ourselves.
      await resetAndRegrant(org.id, tierId);

      // 2. Local display cleanup only: a legacy `credit_exhausted` row is
      //    stale once credits are refreshed. Flip it back to active in the
      //    same UPDATE (no Oblien call — Oblien owns the real gate).
      const wasExhausted = org.subscriptionStatus === "credit_exhausted";
      if (wasExhausted) stats.restored += 1;

      // 3. Single UPDATE that advances the period and (when relevant) clears
      //    the stale credit_exhausted display status. Atomic.
      const newSubscriptionStatus = wasExhausted ? "active" : org.subscriptionStatus;
      await db
        .update(schema.organization)
        .set({
          currentPeriodStart: newPeriodStart,
          currentPeriodEnd: newPeriodEnd,
          subscriptionStatus: newSubscriptionStatus,
        })
        .where(eq(schema.organization.id, org.id));

      // 4. Emit audit event. Fire-and-forget — losing this row is a
      //    forensic gap but doesn't block the next tick. Match the
      //    legacy event_type wrapper shape used by the rest of the
      //    billing module.
      await repos.auditEvent
        .create({
          organizationId: org.id,
          actorUserId: null, // system-emitted
          eventType: "billing.anniversary_reset",
          resourceType: "organization",
          resourceId: org.id,
          ipAddress: null,
          userAgent: null,
          before: {
            planTierId: org.planTierId,
            subscriptionStatus: org.subscriptionStatus,
            currentPeriodStart: org.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
          },
          after: {
            planTierId: org.planTierId,
            subscriptionStatus: newSubscriptionStatus,
            currentPeriodStart: newPeriodStart.toISOString(),
            currentPeriodEnd: newPeriodEnd.toISOString(),
            oblienNamespace: org.oblienNamespace,
            quotaLimit: tier.monthlyCredits,
            quotaService: QUOTA_SERVICE,
            restoredFromExhausted: wasExhausted,
          },
        })
        .catch((err) =>
          console.warn(
            `[billing-anniversary] audit emit failed for org=${org.id}: ${safeErrorMessage(err)}`,
          ),
        );

      stats.reset += 1;
    } catch (err) {
      stats.errors += 1;
      console.error(
        `[billing-anniversary] failed to reset org=${org.id}: ${safeErrorMessage(err)}`,
      );
    }
  }

  return stats;
}

/**
 * Boot-time registration. Idempotent (registering the same jobId
 * replaces). Safe to call unconditionally — exits early on self-hosted
 * since there's no Oblien master client to call quota methods on.
 *
 * Exported under the legacy name `scheduleBillingReset` to keep the
 * boot wiring in app.ts a one-line import swap.
 */
export async function scheduleBillingAnniversary(): Promise<void> {
  if (!env.CLOUD_MODE) {
    // Master Oblien credentials only exist on the SaaS API. The whole
    // anniversary flow is a no-op on self-hosted — period advances
    // come from Stripe (also CLOUD_MODE-only), and there's no quota
    // backend to push to.
    return;
  }

  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: BILLING_ANNIVERSARY_JOB_ID,
    cronExpression: BILLING_ANNIVERSARY_CRON,
    onTick: async () => {
      try {
        const stats = await runAnniversaryReset();
        if (stats.candidates > 0 || stats.errors > 0) {
          console.log(
            `[billing-anniversary] candidates=${stats.candidates} reset=${stats.reset} ` +
              `restored=${stats.restored} skipped=${stats.skipped} errors=${stats.errors}`,
          );
        }
      } catch (err) {
        console.error("[billing-anniversary] sweep failed", err);
      }
    },
  });
}

/**
 * Legacy alias — keep the old import path working through the
 * transition. Callers that already use `scheduleBillingReset` resolve
 * to the new implementation without an import-site edit. Remove once
 * every caller has been migrated.
 */
export const scheduleBillingReset = scheduleBillingAnniversary;
