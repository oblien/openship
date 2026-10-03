import { api } from "./client";
import { endpoints } from "./endpoints";
import type { PlanTierId, CreditPackDefinition, CustomServerResources } from "@repo/core";
import type { ApiPlan } from "@/components/billing/PricingCards";
import type { BillingSubscription, BillingResources, BillingCheckoutStatus, BillingCreditAlerts, BillingCustomQuote, BillingState as BillingStateContract } from "@repo/contracts";
import { trackCloudEvent } from "../cloud-analytics";
export type { BillingResources, BillingCreditAlerts } from "@repo/contracts";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-org billing snapshot rendered on the dashboard's billing overview.
 * Mirrors `BillingState` in `packages/platform/src/engine/modules/billing/billing.repository.ts`
 * — keep the shapes in sync when the API contract changes.
 *
 * Period dates arrive over JSON as ISO strings (not `Date`).
 */
export interface BillingState {
  workspace?: BillingStateContract["workspace"];
  creditAlert?: BillingStateContract["creditAlert"];
  tier: PlanTierId;
  status: string;
  currentPeriod: {
    start: string | null;
    end: string | null;
  };
  balance: {
    /** Convenience alias for `quotaRemaining` — kept for back-compat. */
    total: number | null;
    quotaLimit: number | null;
    quotaUsed: number;
    quotaRemaining: number | null;
    /** Explicitly verified uncapped customer entitlement. A missing limit alone is not unlimited. */
    unlimited?: boolean;
  };
  plan?: ApiPlan | null;
  subscription?: BillingSubscription | null;
  complimentary?: BillingStateContract["complimentary"];
  capabilities?: { portal: boolean; cancellation: boolean; resumption?: boolean; subscriptionChange: boolean };
  /** Included milli-credits: zero without a plan; null for unknown or custom allowances. */
  monthlyCreditLimit: number | null;
  /** Display-only: out of credits (Oblien is the real enforcer). */
  overQuota: boolean;
  /** Build time this period in minutes (openship-derived; Oblien has no build meter). */
  buildTimeMinutes: number | null;
  /** Build allowance resets monthly, even for an annual subscription. */
  buildMinutesResetAt?: string;
  maxServiceMachine?: { tier: string; cpuCores: number; memoryMb: number } | null;
  /**
   * Live resource capacity + consumption, sourced from Openship Cloud. Optional
   * and additive: the self-hosted billing proxy forwards it verbatim when the
   * SaaS provides it, and the dashboard's Capacity panel falls back to the
   * tier's `limits` from the pricing catalog for any ceiling the cloud hasn't
   * sent yet.
   *
   * Each meter is `{ used, max }` where either side may be `null`:
   *   - `used === null` → cloud hasn't reported consumption yet ("syncing").
   *   - `max === null`  → no ceiling on this plan ("unlimited").
   */
  capacity?: BillingCapacity;
  /**
   * MASTER billing-feature availability, decided by Openship Cloud
   * (`BILLING_ENABLED`). When false, new purchases are disabled. Existing
   * customers can still manage their payment details and stop renewal.
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

/** Actual shared allocation comes from Oblien. Missing provider measurements
 * stay unavailable; application counts and legacy build-time meters remain
 * separate. Keep the dashboard aligned with the public billing contract. */
export type BillingCapacity = NonNullable<BillingStateContract["capacity"]>;

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
  workspaceId?: string;
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

/**
 * Tiers eligible for self-serve Stripe Checkout.
 *
 * Derived from `PlanTierId` rather than listed, because the hardcoded
 * `"pro" | "team"` silently excluded every tier added to the catalog afterwards —
 * `starter` ($10) could not be passed to checkout at all, so the cheapest paid
 * plan was unbuyable from the dashboard. `free` has no checkout (it's the
 * default) and `enterprise` is contract sales, so those two are excluded by name;
 * a new PURCHASABLE tier is now included automatically, and the server rejects
 * anything genuinely unpurchasable with `BILLING_PLAN_NOT_PURCHASABLE`.
 */
export type SubscriptionPlanTierId = Exclude<PlanTierId, "free" | "enterprise">;
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
  quoteCustomPlan: async (resources: CustomServerResources): Promise<BillingCustomQuote> => {
    const res = await api.get<Envelope<BillingCustomQuote>>(endpoints.billing.customQuote, { params: { ...resources } });
    return res.data;
  },
  getCheckoutStatus: async (checkoutId: string, workspaceId?: string): Promise<BillingCheckoutStatus> => {
    const res = await api.get<Envelope<BillingCheckoutStatus>>(endpoints.billing.checkout, {
      params: { checkoutId, workspaceId },
    });
    return res.data;
  },
  /** Dashboard overview snapshot — tier, status, period, credit balance. */
  getBillingState: async (workspaceId?: string): Promise<BillingState> => {
    const res = await api.get<Envelope<BillingState>>(endpoints.billing.state, { params: { workspaceId } });
    return res.data;
  },

  getCreditAlerts: async (): Promise<BillingCreditAlerts> => {
    const res = await api.get<Envelope<BillingCreditAlerts>>(endpoints.billing.creditAlerts);
    return res.data;
  },

  getResources: async (workspaceId?: string): Promise<BillingResources> => {
    const res = await api.get<Envelope<BillingResources>>(endpoints.billing.resources, { params: { workspaceId } });
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
        workspaceId: params.workspaceId,
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
   * Start an Oblien-hosted checkout. Provider events confirm the paid plan.
   */
  createSubscriptionCheckout: async (
    planTierId: SubscriptionPlanTierId,
    interval: SubscriptionInterval,
    workspaceId?: string,
  ): Promise<{ checkoutUrl: string }> => {
    trackCloudEvent({ event: "cloud_checkout_clicked", properties: { kind: "subscription", surface: "billing" } });
    const res = await api.post<Envelope<{ checkoutUrl: string }>>(
      endpoints.billing.subscription,
      { planTierId, interval, workspaceId, idempotencyKey: crypto.randomUUID() },
    );
    return res.data;
  },

  /**
   * Start an Oblien-hosted top-up. Oblien applies credits after payment.
   */
  createTopupCheckout: async (packId: string, workspaceId?: string): Promise<{ checkoutUrl: string }> => {
    trackCloudEvent({ event: "cloud_checkout_clicked", properties: { kind: "topup", surface: "billing" } });
    const res = await api.post<Envelope<{ checkoutUrl: string }>>(
      endpoints.billing.topup,
      { packId, workspaceId, idempotencyKey: crypto.randomUUID() },
    );
    return res.data;
  },

  /**
   * Mint a Stripe Portal session for the org so the user can manage
   * payment methods + invoices. Each call returns a fresh short-lived
   * URL — never cache.
   */
  getPortalUrl: async (workspaceId?: string): Promise<{ portalUrl: string }> => {
    const res = await api.post<Envelope<{ portalUrl: string }>>(
      endpoints.billing.portal,
      { workspaceId },
    );
    return res.data;
  },

  cancelSubscription: async (workspaceId?: string): Promise<{ cancelAt: string | null; subscription: BillingSubscription }> => {
    const res = await api.post<Envelope<{ cancelAt: string | null; subscription: BillingSubscription }>>(endpoints.billing.cancel, { workspaceId });
    return res.data;
  },

  resumeSubscription: async (workspaceId?: string): Promise<{ subscription: BillingSubscription }> => {
    const res = await api.post<Envelope<{ subscription: BillingSubscription }>>(endpoints.billing.resume, { workspaceId });
    return res.data;
  },
};
