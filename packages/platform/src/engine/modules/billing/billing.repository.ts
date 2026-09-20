/** Live provider billing state plus read access to historical billing records. */

import { eq, and, desc, inArray, db, schema, repos } from "@repo/db";
import {
  generateId,
  safeErrorMessage,
  CREDIT_PACKS,
  PLANS,
  planLimits,
  RESOURCE_TIER_SPECS,
  resolveCreditPackPriceId,
  type PlanTierId,
  type CreditPackDefinition,
} from "@repo/core";
import { entitlementQuota, syncOblienEntitlement } from "./billing-oblien-quota";
import { cloudPlan } from "./billing-catalog";
import { canTopUpCloudSubscription, presentCloudSubscription } from "./billing-subscription";
import { ensureNamespace } from "../../lib/openship-cloud";
import { getBuildMinuteUsage, getFreeSubdomainUsage } from "@repo/platform/engine/lib/plan-guard";
import { env } from "@repo/platform/engine/config/env";

const {
  billingCustomer,
  billingSubscription,
  creditPack,
  organization,
} = schema;

// ─── Public types ────────────────────────────────────────────────────────────

/** Stored timestamps become ISO strings at the shared operation boundary. */
export type BillingState = Omit<import("@repo/contracts").BillingState, "currentPeriod" | "buildMinutesResetAt"> & {
  currentPeriod: { start: Date | null; end: Date | null };
  buildMinutesResetAt: Date;
};

export interface BillingCustomer {
  id: string;
  organizationId: string;
  stripeCustomerId: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSubscriptionInput {
  organizationId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  planTierId: PlanTierId;
  interval: "monthly" | "annual";
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
}

// ─── getBillingState ─────────────────────────────────────────────────────────

/** Mirror fresh provider entitlement and add Openship application usage. */
export async function getBillingState(orgId: string): Promise<BillingState> {
  await ensureNamespace(orgId);
  const { entitlement, tier, subscription: providerSubscription } = await syncOblienEntitlement(orgId, { syncResourceLimits: false });
  const [plan, legacySubscriptions] = await Promise.all([
    // A setup-only workspace has no product to look up. Catalog availability
    // must not hide a customer's balance, invoices or subscription controls.
    tier === "free" ? null : cloudPlan(tier).catch(error => {
      console.warn(`[billing] Plan details are temporarily unavailable: ${safeErrorMessage(error)}`);
      return null;
    }),
    listLiveSubscriptions(orgId),
  ]);
  const subscription = presentCloudSubscription(providerSubscription);
  const managed = legacySubscriptions.length === 0;
  const canTopUp = canTopUpCloudSubscription(providerSubscription);
  // A missing free catalog product is intentional: project setup is not a
  // subscription and includes no Cloud credits. Preserve any purchased balance.
  const monthlyCreditLimit = tier === "free" ? 0 : plan?.monthlyCredits ?? null;
  const { quotaLimit, quotaUsed, quotaRemaining } = entitlementQuota(entitlement);
  const overQuota = quotaRemaining !== null && quotaRemaining <= 0;

  // Build time + free subdomains, read through the SAME helpers the plan gate
  // enforces with. This used to compute its own window (the org's billing period,
  // falling back to a rolling 30 days) — which, now that build minutes are
  // actually enforced, would have shown a user "3 of 15 used" while a different
  // window refused their deploy. One window, one number, one source.
  const [buildMinutes, freeSubdomains, servicesUsed, projectsUsed] = await Promise.all([
    getBuildMinuteUsage(orgId),
    getFreeSubdomainUsage(orgId),
    // Running services = Oblien workspaces, the ceiling customers feel most.
    repos.service.countRunningForOrg(orgId).catch(() => null),
    repos.projectGroup
      .listByOrganization(orgId, { page: 1, perPage: 1 })
      .then((r) => r.total)
      .catch(() => null),
  ]);
  const buildTimeMinutes = buildMinutes.usedMinutes;
  const planLimitsForTier = planLimits(tier);

  return {
    tier,
    status: entitlement.status,
    plan,
    subscription,
    capabilities: {
      portal: managed,
      cancellation: managed && subscription !== null && subscription.status !== "canceled",
      resumption: managed && subscription !== null && subscription.status !== "canceled" && subscription.cancelAtPeriodEnd,
      subscriptionChange: managed && env.BILLING_ENABLED,
    },
    currentPeriod: {
      start: entitlement.periodStart ? new Date(entitlement.periodStart) : null,
      end: entitlement.periodEnd ? new Date(entitlement.periodEnd) : null,
    },
    balance: {
      total: quotaRemaining,
      quotaLimit,
      quotaUsed,
      quotaRemaining,
      unlimited: tier === "enterprise" && entitlement.status === "active" && subscription !== null
        && ["active", "trialing"].includes(subscription.status) && quotaLimit === null && quotaRemaining === null,
    },
    monthlyCreditLimit,
    overQuota,
    buildTimeMinutes,
    buildMinutesResetAt: buildMinutes.periodEnd,
    maxServiceMachine: tier !== "free" && planLimitsForTier.maxResourceTier
      ? {
          tier: planLimitsForTier.maxResourceTier,
          cpuCores: RESOURCE_TIER_SPECS[planLimitsForTier.maxResourceTier].cpuCores,
          memoryMb: RESOURCE_TIER_SPECS[planLimitsForTier.maxResourceTier].memoryMb,
        }
      : null,
    /**
     * The two allowances the plan gate actually refuses on, as meters. Both were
     * declared in this contract and never populated — the dashboard's "Free
     * routes" meter has been dead code — so a customer could hit a limit the UI
     * never showed them approaching. `max: null` = unlimited on this tier.
     */
    capacity: {
      routes: { used: freeSubdomains.used, max: freeSubdomains.limit },
      buildMinutes: { used: buildMinutes.usedMinutes, max: tier === "free" ? 0 : buildMinutes.limitMinutes },
      // Both of these have a REAL used count, unlike the vCPU/RAM/disk meters
      // that were declared here and never populated (four permanently empty rows
      // the dashboard rendered as "Syncing from cloud" forever). Per-service
      // machine size is deliberately NOT a meter: Oblien's ceilings are
      // per-workspace, so there is no pool to fill.
      services: { used: servicesUsed, max: planLimitsForTier.runningServices },
      projects: { used: projectsUsed, max: planLimitsForTier.maxProjects },
    },
    billing: {
      enabled: env.BILLING_ENABLED,
      status: env.BILLING_ENABLED ? "live" : "coming_soon",
    },
    topups: {
      // Top-ups need the master switch AND the sub-switch.
      available: canTopUp && managed && env.BILLING_ENABLED && env.BILLING_TOPUPS_ENABLED,
      status: !canTopUp || !managed ? "unavailable" : env.BILLING_ENABLED && env.BILLING_TOPUPS_ENABLED ? "available" : "coming_soon",
    },
  };
}

// ─── billing_customer ────────────────────────────────────────────────────────

/** Stripe statuses where a subscription is live enough to CHANGE rather than
 *  re-create. `past_due`/`unpaid` are included deliberately: the customer still
 *  has a subscription object, and upgrading them must swap its price, not open a
 *  second one alongside it. */
const CHANGEABLE_STATUSES = ["active", "trialing", "past_due", "unpaid"] as const;

/**
 * The org's subscription that an upgrade/downgrade should modify, if any.
 *
 * Newest first, because a historical canceled row must never be picked up and
 * re-priced. Returns undefined when the org has no live subscription, which is
 * the signal to open a fresh Checkout Session.
 */
export async function findChangeableSubscription(orgId: string) {
  const [row] = await db
    .select()
    .from(billingSubscription)
    .where(
      and(
        eq(billingSubscription.organizationId, orgId),
        inArray(billingSubscription.status, [...CHANGEABLE_STATUSES]),
      ),
    )
    .orderBy(desc(billingSubscription.createdAt))
    .limit(1);
  return row;
}

/**
 * EVERY live subscription for the org, newest first.
 *
 * Cancellation needs the full set, not just the newest: before upgrades became an
 * in-place price change, a paid→paid upgrade could leave two active
 * subscriptions, and cancelling only the newest left the older one billing
 * indefinitely. Any org in that state predates the fix and still needs cleaning
 * up, so cancel operates on all of them.
 */
export async function listLiveSubscriptions(orgId: string) {
  return db
    .select()
    .from(billingSubscription)
    .where(
      and(
        eq(billingSubscription.organizationId, orgId),
        inArray(billingSubscription.status, [...CHANGEABLE_STATUSES]),
      ),
    )
    .orderBy(desc(billingSubscription.createdAt));
}

/**
 * Idempotent customer upsert keyed on `organization_id`. Used by the
 * checkout flow (we create the Stripe customer before opening the
 * session) and the webhook handler (defensive — Stripe events are
 * source-of-truth for the stripe_customer_id mapping).
 */
export async function upsertCustomer(input: {
  orgId: string;
  stripeCustomerId: string;
  email: string;
}): Promise<BillingCustomer> {
  const id = generateId("bc");
  await db
    .insert(billingCustomer)
    .values({
      id,
      organizationId: input.orgId,
      stripeCustomerId: input.stripeCustomerId,
      email: input.email,
    })
    .onConflictDoUpdate({
      target: billingCustomer.organizationId,
      set: {
        stripeCustomerId: input.stripeCustomerId,
        email: input.email,
        updatedAt: new Date(),
      },
    });

  const [row] = await db
    .select()
    .from(billingCustomer)
    .where(eq(billingCustomer.organizationId, input.orgId))
    .limit(1);

  return row as BillingCustomer;
}

export async function getCustomerByOrg(
  orgId: string,
): Promise<BillingCustomer | null> {
  const [row] = await db
    .select()
    .from(billingCustomer)
    .where(eq(billingCustomer.organizationId, orgId))
    .limit(1);
  return (row as BillingCustomer | undefined) ?? null;
}

// ─── billing_subscription ────────────────────────────────────────────────────

/**
 * Insert-or-update by `stripe_subscription_id`. The webhook is the only
 * caller; status transitions (active → past_due → canceled etc.) are
 * captured by re-issuing this upsert with the new status. The org's
 * denormalized `subscription_status` / period columns are bumped in the
 * same tx so the gating path stays consistent.
 */
export async function upsertSubscription(
  input: UpsertSubscriptionInput,
): Promise<void> {
  const id = generateId("bs");
  await db.transaction(async (tx) => {
    await tx
      .insert(billingSubscription)
      .values({
        id,
        organizationId: input.organizationId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripePriceId: input.stripePriceId,
        planTierId: input.planTierId,
        interval: input.interval,
        status: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      })
      .onConflictDoUpdate({
        target: billingSubscription.stripeSubscriptionId,
        set: {
          stripePriceId: input.stripePriceId,
          planTierId: input.planTierId,
          interval: input.interval,
          status: input.status,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
          updatedAt: new Date(),
        },
      });

    await tx
      .update(organization)
      .set({
        planTierId: input.planTierId,
        subscriptionStatus: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
      })
      .where(eq(organization.id, input.organizationId));
  });
}

// ─── credit_pack catalog ─────────────────────────────────────────────────────

/**
 * Boot-time sync: write each pricing-catalog top-up pack into the `credit_pack`
 * table. Uses `stripe_price_id` as the conflict target (it's the natural key —
 * webhook handlers resolve it back to a pack row). Packs already in the DB but
 * missing from the catalog are marked inactive (not deleted — historical Stripe
 * events still need to resolve the row).
 *
 * A pack whose Stripe price id isn't configured in the environment is SKIPPED
 * rather than written: `stripe_price_id` is the natural key and NOT NULL, so the
 * old behaviour of writing a `price_..._placeholder` string minted a row that
 * could never match a real Stripe event and permanently occupied the key. The
 * count of skips is returned so the caller can log it.
 */
export async function syncCreditPacksFromConstants(): Promise<{
  upserted: number;
  deactivated: number;
  skipped: string[];
}> {
  const liveStripePriceIds = new Set<string>();
  const skipped: string[] = [];
  let upserted = 0;

  for (const pack of CREDIT_PACKS as readonly CreditPackDefinition[]) {
    const stripePriceId = resolveCreditPackPriceId(pack.id);
    if (!stripePriceId) {
      skipped.push(pack.id);
      continue;
    }
    liveStripePriceIds.add(stripePriceId);
    await db
      .insert(creditPack)
      .values({
        id: pack.id.startsWith("cp_") ? pack.id : `cp_${pack.id}`,
        name: pack.name,
        creditsMilli: pack.credits_milli,
        priceCents: pack.price_cents,
        // No product id in the catalog; reuse the price id so the NOT NULL
        // column is satisfied. Stripe webhook handlers don't dereference it.
        stripeProductId: stripePriceId,
        stripePriceId,
        active: true,
        sortOrder: pack.sortOrder,
      })
      .onConflictDoUpdate({
        target: creditPack.stripePriceId,
        set: {
          name: pack.name,
          creditsMilli: pack.credits_milli,
          priceCents: pack.price_cents,
          stripeProductId: stripePriceId,
          active: true,
          sortOrder: pack.sortOrder,
        },
      });
    upserted += 1;
  }

  // Deactivate packs no longer in the catalog. Returning + counting so the
  // caller can log a delta at boot.
  const stale = await db
    .select({ stripePriceId: creditPack.stripePriceId })
    .from(creditPack)
    .where(eq(creditPack.active, true));

  let deactivated = 0;
  for (const row of stale) {
    if (!liveStripePriceIds.has(row.stripePriceId)) {
      await db
        .update(creditPack)
        .set({ active: false })
        .where(eq(creditPack.stripePriceId, row.stripePriceId));
      deactivated += 1;
    }
  }

  return { upserted, deactivated, skipped };
}
