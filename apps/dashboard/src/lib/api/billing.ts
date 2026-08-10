import { api } from "./client";
import { endpoints } from "./endpoints";
import type { PlanTierId, CreditPackDefinition } from "@repo/core";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-org billing snapshot rendered on the dashboard's billing overview.
 * Mirrors `BillingState` in `apps/api/src/modules/billing/billing.repository.ts`
 * — keep the shapes in sync when the API contract changes.
 *
 * Period dates arrive over JSON as ISO strings (not `Date`).
 */
export interface BillingState {
  tier: PlanTierId;
  status: string;
  currentPeriod: {
    start: string | null;
    end: string | null;
  };
  balance: {
    /** Convenience alias for `quotaRemaining` — kept for back-compat. */
    total: number;
    quotaLimit: number;
    quotaUsed: number;
    quotaRemaining: number;
  };
  /** Tier's monthly allowance in milli-credits, or `null` for enterprise. */
  monthlyCreditLimit: number | null;
  /** Display-only: out of credits (Oblien is the real enforcer). */
  overQuota: boolean;
  /** Build time this period in minutes (openship-derived; Oblien has no build meter). */
  buildTimeMinutes: number;
  /**
   * Live resource capacity + consumption, sourced from Openship Cloud. Optional
   * and additive: the self-hosted billing proxy forwards it verbatim when the
   * SaaS provides it, and the dashboard's Capacity panel falls back to the
   * tier's static `oblienLimits` for any ceiling the cloud hasn't sent yet.
   *
   * Each meter is `{ used, max }` where either side may be `null`:
   *   - `used === null` → cloud hasn't reported consumption yet ("syncing").
   *   - `max === null`  → no ceiling on this plan ("unlimited").
   */
  capacity?: BillingCapacity;
  /**
   * MASTER billing-feature availability, decided by Openship Cloud
   * (`BILLING_ENABLED`). When `enabled` is false the whole billing feature is
   * pre-launch: the UI shows a "coming soon" surface and every Stripe-mutating
   * endpoint is refused server-side. Optional/defensive: treated as NOT enabled
   * when absent, so billing stays gated until the cloud turns it on — no
   * dashboard release needed to launch.
   */
  billing?: BillingFeature;
  /**
   * One-time credit top-up availability, decided by Openship Cloud. Requires
   * the master `billing.enabled` AND the top-ups sub-switch. The UI enables the
   * buy flow only when `available` is true; otherwise it shows the "coming soon"
   * preview. Optional/defensive: treated as NOT available when absent.
   */
  topups?: TopupAvailability;
}

export interface BillingFeature {
  enabled: boolean;
  status?: "live" | "coming_soon" | "disabled";
}

export interface TopupAvailability {
  available: boolean;
  status?: "available" | "coming_soon" | "unavailable";
}

/** One resource meter: consumption against a ceiling. Either side may be null. */
export interface CapacityMeter {
  used: number | null;
  max: number | null;
}

/**
 * Per-resource capacity snapshot. All fields optional so the cloud can grow the
 * set without a dashboard release. Units:
 *   routes/workspaces/vcpus → whole counts · ramMb → MB · diskGb/bandwidthGb → GB.
 */
export interface BillingCapacity {
  /** Free *.opsh.io edge routes the org is using vs its allowed maximum. */
  routes?: CapacityMeter;
  workspaces?: CapacityMeter;
  vcpus?: CapacityMeter;
  ramMb?: CapacityMeter;
  diskGb?: CapacityMeter;
  bandwidthGb?: CapacityMeter;
}

/**
 * One credit pack the user can buy as a one-shot top-up.
 *
 * Sourced from the synced `credit_pack` table when present; falls back
 * to the in-code `CREDIT_PACKS` constant on first boot — both share the
 * `CreditPackDefinition` shape.
 */
export type CreditPack = CreditPackDefinition;

/**
 * Granularity for the usage chart. `day` is Oblien's default.
 */
export type UsageGroupBy = "hour" | "day";

/**
 * Query params for `getUsage`. Dates are passed as ISO strings; all
 * three fields are optional — the API defaults to the last 30 days
 * grouped by day.
 */
export interface UsageQuery {
  from?: string;
  to?: string;
  groupBy?: UsageGroupBy;
}

/**
 * Raw Oblien usage rollup. Keys are snake_case because the dashboard
 * chart already speaks Oblien's vocabulary — renaming here would force
 * a translation layer at every reader. Treated as opaque on this
 * boundary; consumers cast to the SDK's `NamespaceUsageUnits` when they
 * need fine-grained access.
 */
export type UsageUnits = Record<string, unknown>;

/**
 * Response from `GET /api/billing/usage`. The API echoes back the
 * resolved range so the chart doesn't have to re-derive the window
 * when the caller relied on defaults. `usage` is `null` when the org
 * hasn't been provisioned an Oblien namespace yet.
 */
export interface UsageResponse {
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  usage: UsageUnits | null;
}

/** Subscription tiers eligible for self-serve Stripe Checkout. */
export type SubscriptionPlanTierId = "pro" | "team";
export type SubscriptionInterval = "monthly" | "annual";

/* ------------------------------------------------------------------ */
/*  Response envelope                                                 */
/* ------------------------------------------------------------------ */

/**
 * Billing controllers wrap every successful response in `{ data: ... }`.
 * We strip the envelope here so callers see the same flat shape the
 * other dashboard APIs return.
 */
interface Envelope<T> {
  data: T;
}

/* ------------------------------------------------------------------ */
/*  Client                                                            */
/* ------------------------------------------------------------------ */

export const billingApi = {
  /** Dashboard overview snapshot — tier, status, period, credit balance. */
  getBillingState: async (): Promise<BillingState> => {
    const res = await api.get<Envelope<BillingState>>(endpoints.billing.state);
    return res.data;
  },

  /**
   * Raw metered usage buckets + totals for the chart. All params are
   * optional — the API defaults to the last 30 days, day buckets.
   */
  getUsage: async (params: UsageQuery = {}): Promise<UsageResponse> => {
    const res = await api.get<Envelope<UsageResponse>>(endpoints.billing.usage, {
      params: {
        from: params.from,
        to: params.to,
        groupBy: params.groupBy,
      },
    });
    return res.data;
  },

  /** Active top-up credit packs surfaced in the buy-more modal. */
  getTopupPacks: async (): Promise<CreditPack[]> => {
    const res = await api.get<Envelope<CreditPack[]>>(endpoints.billing.topupPacks);
    return res.data;
  },

  /**
   * Start a Stripe Checkout session to upgrade the org to a paid tier.
   * The `customer.subscription.*` webhooks finalize the local row when
   * the user completes payment.
   */
  createSubscriptionCheckout: async (
    planTierId: SubscriptionPlanTierId,
    interval: SubscriptionInterval,
  ): Promise<{ checkoutUrl: string }> => {
    const res = await api.post<Envelope<{ checkoutUrl: string }>>(
      endpoints.billing.subscription,
      { planTierId, interval },
    );
    return res.data;
  },

  /**
   * Start a Stripe Checkout session for a one-shot credit pack top-up.
   * The `checkout.session.completed` webhook applies the credits to the
   * org's Oblien quota.
   */
  createTopupCheckout: async (packId: string): Promise<{ checkoutUrl: string }> => {
    const res = await api.post<Envelope<{ checkoutUrl: string }>>(
      endpoints.billing.topup,
      { packId },
    );
    return res.data;
  },

  /**
   * Mint a Stripe Portal session for the org so the user can manage
   * payment methods + invoices. Each call returns a fresh short-lived
   * URL — never cache.
   */
  getPortalUrl: async (): Promise<{ portalUrl: string }> => {
    const res = await api.post<Envelope<{ portalUrl: string }>>(
      endpoints.billing.portal,
    );
    return res.data;
  },
};

