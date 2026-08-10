/**
 * Billing repository — DB-only, no Stripe calls.
 *
 * This module owns the Stripe → Oblien quota bridge. We persist enough
 * Stripe state locally to attribute webhooks (`billing_customer`), to
 * track tier/status/period transitions for the dashboard
 * (`billing_subscription`), and to resolve top-up `price_id`s to a
 * known SKU (`credit_pack`). Credit consumption itself is no longer
 * tracked here — Oblien owns the ledger. `getBillingState` reads the
 * authoritative quota numbers from Oblien via the
 * `billing-oblien-quota` helper.
 */

import { eq, db, schema, repos } from "@repo/db";
import {
  generateId,
  safeErrorMessage,
  CREDIT_PACKS,
  PLANS,
  type PlanTierId,
  type CreditPackDefinition,
} from "@repo/core";
import { getQuotaState } from "./billing-oblien-quota";
import { env } from "../../config/env";

const {
  billingCustomer,
  billingSubscription,
  creditPack,
  organization,
} = schema;

// ─── Public types ────────────────────────────────────────────────────────────

export interface BillingState {
  tier: PlanTierId;
  status: string;
  currentPeriod: {
    start: Date | null;
    end: Date | null;
  };
  balance: {
    /** Convenience alias for `quotaRemaining` — kept for dashboard back-compat. */
    total: number;
    quotaLimit: number;
    quotaUsed: number;
    quotaRemaining: number;
  };
  /** Tier's monthly allowance in milli-credits, or null when Oblien doesn't surface one. */
  monthlyCreditLimit: number | null;
  /**
   * Display-only: the org is out of credits (quota_used ≥ limit). Derived live
   * from the balance — NOT a locally-managed state. Oblien owns the actual
   * enforcement (stops workspaces at overdraft); this just drives the UI badge.
   */
  overQuota: boolean;
  /**
   * Total build time this period, in minutes. Openship-derived (sum of
   * build-session durations) — Oblien does not meter build separately.
   */
  buildTimeMinutes: number;
  /**
   * Live per-resource capacity + consumption for the dashboard's Capacity
   * panel. Optional + additive: populated on the cloud once the resource
   * meters are wired, forwarded verbatim by the self-hosted billing proxy.
   * Each meter is `{ used, max }`; `used === null` = not yet reported,
   * `max === null` = no ceiling on this plan. Keep in sync with the dashboard
   * `BillingCapacity` type in apps/dashboard/src/lib/api/billing.ts.
   */
  capacity?: {
    routes?: { used: number | null; max: number | null };
    workspaces?: { used: number | null; max: number | null };
    vcpus?: { used: number | null; max: number | null };
    ramMb?: { used: number | null; max: number | null };
    diskGb?: { used: number | null; max: number | null };
    bandwidthGb?: { used: number | null; max: number | null };
  };
  /**
   * MASTER billing-feature availability, decided by Openship Cloud and driven
   * by `BILLING_ENABLED`. Every mode reads this (SaaS builds it; self-hosted +
   * local forward it verbatim through the billing proxy) so the dashboard knows
   * whether billing is live or "coming soon". Stripe-mutating endpoints enforce
   * the same flag server-side, so billing goes live by flipping the cloud flag —
   * no dashboard or self-hosted release.
   */
  billing: {
    enabled: boolean;
    status: "live" | "coming_soon" | "disabled";
  };
  /**
   * One-time credit top-up availability. Requires BOTH the master switch and
   * `BILLING_TOPUPS_ENABLED`, so subscriptions can launch before top-ups. The
   * dashboard uses it to enable the buy flow or show the "coming soon" preview.
   */
  topups: {
    available: boolean;
    status: "available" | "coming_soon" | "unavailable";
  };
}

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

/**
 * Per-org billing snapshot suitable for the dashboard overview card.
 *
 * Reads tier/status/period from the local `organization` row and fans
 * out to Oblien for the quota numbers (limit / used / remaining). The
 * Oblien call is wrapped in `getQuotaState` so this function stays a
 * pure read-aggregator over two sources.
 */
export async function getBillingState(orgId: string): Promise<BillingState> {
  const [org] = await db
    .select({
      planTierId: organization.planTierId,
      subscriptionStatus: organization.subscriptionStatus,
      currentPeriodStart: organization.currentPeriodStart,
      currentPeriodEnd: organization.currentPeriodEnd,
      oblienNamespace: organization.oblienNamespace,
    })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);

  if (!org) {
    throw new Error(`Organization not found: ${orgId}`);
  }

  const tier = org.planTierId as PlanTierId;
  // Tier baseline — the contractually-granted monthly allowance. This is
  // separate from the live Oblien quota ceiling (which can include topups
  // and is the source of truth for current entitlement).
  const monthlyCreditLimit = PLANS[tier]?.monthlyCredits ?? null;

  // Live Oblien quota is authoritative. It can throw (Oblien unreachable) or
  // return null (namespace not provisioned / no `compute` row) — in both cases
  // fall back to the last `credits.usage` snapshot so the dashboard degrades
  // gracefully instead of 500ing. All three sources speak milli-credits.
  let quota: Awaited<ReturnType<typeof getQuotaState>> = null;
  try {
    quota = await getQuotaState(orgId);
  } catch (err) {
    console.warn(
      `[billing] live quota read failed for org ${orgId}; falling back to usage snapshot: ${safeErrorMessage(err)}`,
    );
  }

  const snapshot = await repos.billingUsageSnapshot.findByOrg(orgId).catch(() => null);

  const quotaUsed = quota?.quotaUsed ?? snapshot?.creditsUsed ?? 0;
  // `quotaLimit === null` (Oblien "unlimited") falls through to the derived
  // snapshot limit (balance + used), then the tier baseline, then 0.
  const quotaLimit =
    quota?.quotaLimit ??
    (snapshot?.balance != null
      ? snapshot.balance + (snapshot.creditsUsed ?? 0)
      : null) ??
    monthlyCreditLimit ??
    0;
  const rawRemaining =
    quota?.quotaRemaining ??
    (snapshot?.balance != null ? Math.max(0, snapshot.balance) : Math.max(0, quotaLimit - quotaUsed));
  // Oblien reports Infinity for an unlimited quota — clamp to the numeric
  // limit so the dashboard contract stays finite/serializable.
  const quotaRemaining = Number.isFinite(rawRemaining) ? rawRemaining : quotaLimit;

  // Display-only over-quota flag (Oblien is the real enforcer).
  const overQuota = quotaLimit > 0 && quotaRemaining <= 0;

  // Build time this period (openship-derived). Window = the org's billing
  // period, or the last 30 days when no period is set (fresh free org).
  const periodEnd = org.currentPeriodEnd ?? new Date();
  const periodStart =
    org.currentPeriodStart ?? new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
  const buildMillis = await repos.deployment
    .sumBuildMillisForOrg(orgId, periodStart, periodEnd)
    .catch(() => 0);
  const buildTimeMinutes = Math.round(buildMillis / 60_000);

  return {
    tier,
    status: org.subscriptionStatus,
    currentPeriod: {
      start: org.currentPeriodStart ?? null,
      end: org.currentPeriodEnd ?? null,
    },
    balance: {
      total: quotaRemaining,
      quotaLimit,
      quotaUsed,
      quotaRemaining,
    },
    monthlyCreditLimit,
    overQuota,
    buildTimeMinutes,
    billing: {
      enabled: env.BILLING_ENABLED,
      status: env.BILLING_ENABLED ? "live" : "coming_soon",
    },
    topups: {
      // Top-ups need the master switch AND the sub-switch.
      available: env.BILLING_ENABLED && env.BILLING_TOPUPS_ENABLED,
      status: env.BILLING_ENABLED && env.BILLING_TOPUPS_ENABLED ? "available" : "coming_soon",
    },
  };
}

// ─── billing_customer ────────────────────────────────────────────────────────

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
 * Boot-time sync: write each `CREDIT_PACKS` entry from constants.ts into
 * the `credit_pack` table. Uses `stripe_price_id` as the conflict target
 * (it's the natural key — webhook handlers resolve it back to a pack
 * row). Packs already in the DB but missing from constants are marked
 * inactive (not deleted — historical Stripe events still need to resolve
 * the row).
 */
export async function syncCreditPacksFromConstants(): Promise<{
  upserted: number;
  deactivated: number;
}> {
  const liveStripePriceIds = new Set<string>();
  let upserted = 0;

  for (const pack of CREDIT_PACKS as readonly CreditPackDefinition[]) {
    liveStripePriceIds.add(pack.stripePriceId);
    await db
      .insert(creditPack)
      .values({
        id: pack.id.startsWith("cp_") ? pack.id : `cp_${pack.id}`,
        name: pack.name,
        creditsMilli: pack.credits_milli,
        priceCents: pack.price_cents,
        // No product id in constants today; reuse the price id as a
        // placeholder so the NOT NULL column is satisfied. Stripe
        // webhook handlers don't dereference it.
        stripeProductId: pack.stripePriceId,
        stripePriceId: pack.stripePriceId,
        active: true,
        sortOrder: pack.sortOrder,
      })
      .onConflictDoUpdate({
        target: creditPack.stripePriceId,
        set: {
          name: pack.name,
          creditsMilli: pack.credits_milli,
          priceCents: pack.price_cents,
          stripeProductId: pack.stripePriceId,
          active: true,
          sortOrder: pack.sortOrder,
        },
      });
    upserted += 1;
  }

  // Deactivate packs no longer in constants. Returning + counting so the
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

  return { upserted, deactivated };
}
