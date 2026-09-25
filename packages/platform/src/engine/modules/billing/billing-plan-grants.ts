/**
 * Complimentary plans use Oblien's Mode A quota API. Hosted subscriptions stay
 * entirely in Mode B. Only the operator CLI can issue/revoke a grant; normal
 * reconciliation renews its saved allowance without charging the customer.
 * Call mutations under billing:entitlement:<organizationId>, also held by the CLI.
 */
import { AppError, PLAN_IDS, planLimitsSchema, type PlanTierId } from "@repo/core";
import type { BillingPlanGrant, BillingPlanGrantRepo } from "@repo/db/factory";
import {
  assertOblienEntitlementMatchesSubscription, oblienOfferSchema,
  type OblienBillingApi, type OblienEntitlement, type OblienSubscription,
} from "../../lib/oblien-billing-api";
import { cloudNamespaceLimits, syncCloudResourceLimits } from "../../lib/cloud-resource-limits";
import { offerReference, subscriptionPlan } from "./billing-catalog";

export const cloudBillingLockKey = (organizationId: string) => `billing:entitlement:${organizationId}`;

export interface ProviderBillingState {
  entitlement: OblienEntitlement;
  subscription: OblienSubscription;
}

/** Preserve the provider response; a complimentary grant is never a fake subscription. */
export async function readProviderBilling(billing: OblienBillingApi, namespace: string): Promise<ProviderBillingState> {
  const [entitlement, state] = await Promise.all([billing.getEntitlement(namespace), billing.getSubscription(namespace)]);
  if (entitlement.namespace !== namespace || state.namespace !== namespace) {
    throw new AppError("Cloud billing returned another namespace", 502, "OBLIEN_ENTITLEMENT_MISMATCH");
  }
  assertOblienEntitlementMatchesSubscription(entitlement, state.subscription);
  return { entitlement, subscription: state.subscription };
}

/** Monthly anniversaries preserve UTC time and clamp month-end/leap-day dates. */
export function planGrantPeriod(createdAt: Date, now: Date, expiresAt: Date | null = null) {
  const anniversary = (month: number) => new Date(Date.UTC(
    createdAt.getUTCFullYear(), createdAt.getUTCMonth() + month,
    Math.min(createdAt.getUTCDate(), new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth() + month + 1, 0)).getUTCDate()),
    createdAt.getUTCHours(), createdAt.getUTCMinutes(), createdAt.getUTCSeconds(), createdAt.getUTCMilliseconds(),
  ));
  let months = Math.max(0, (now.getUTCFullYear() - createdAt.getUTCFullYear()) * 12 + now.getUTCMonth() - createdAt.getUTCMonth());
  if (months > 0 && anniversary(months).getTime() > now.getTime()) months--;
  const start = anniversary(months);
  const next = anniversary(months + 1);
  return { start, end: expiresAt && expiresAt < next ? expiresAt : next };
}

export function resolvePlanGrant(row: BillingPlanGrant, organizationId: string, namespace: string, now: Date) {
  const offer = oblienOfferSchema.safeParse(row.offer);
  const limits = planLimitsSchema.strict().safeParse(row.limits);
  const tier = row.planTierId as PlanTierId;
  if (row.organizationId !== organizationId || row.namespace !== namespace || !PLAN_IDS.includes(tier) || tier === "free" ||
      !offer.success || !limits.success || offer.data.reference !== offerReference(tier) || !offer.data.policy || !offer.data.resourceLimits ||
      row.createdAt > now) {
    throw new AppError("The complimentary plan grant could not be verified", 503, "BILLING_PLAN_GRANT_INVALID");
  }
  return {
    id: row.id, tier, offer: offer.data, limits: limits.data,
    resourceLimits: offer.data.resourceLimits, policy: offer.data.policy,
    expiresAt: row.expiresAt, period: planGrantPeriod(row.createdAt, now, row.expiresAt),
  };
}
export type ResolvedPlanGrant = ReturnType<typeof resolvePlanGrant>;

async function applyGrantPolicy(billing: OblienBillingApi, namespace: string, desired: Parameters<OblienBillingApi["setPolicy"]>[1]) {
  const policy = await billing.setPolicy(namespace, desired);
  if (policy.quotaLimit !== desired.quotaLimit || policy.overdraft !== desired.overdraft ||
      policy.suspendThreshold !== desired.suspendThreshold || policy.onOverdraftAction !== desired.onOverdraftAction) {
    throw new AppError("Cloud did not confirm the complimentary allowance", 502, "BILLING_PLAN_GRANT_UNCONFIRMED");
  }
}

export function effectiveCloudPlan(state: ProviderBillingState, grant: ResolvedPlanGrant | null, organizationId: string) {
  const plan = grant ?? subscriptionPlan(state.subscription, organizationId, state.entitlement.namespace);
  return {
    tier: plan.tier, limits: plan.limits, resourceLimits: plan.resourceLimits,
    currentPeriodStart: grant?.period.start ?? (state.entitlement.periodStart ? new Date(state.entitlement.periodStart) : null),
    currentPeriodEnd: grant?.period.end ?? (state.entitlement.periodEnd ? new Date(state.entitlement.periodEnd) : null),
  };
}

export async function reconcilePlanGrant(input: {
  organizationId: string;
  namespace: string;
  grants: BillingPlanGrantRepo;
  billing: OblienBillingApi;
  state: ProviderBillingState;
  now?: Date;
  syncLimits?: typeof syncCloudResourceLimits;
}): Promise<ProviderBillingState & { grant: ResolvedPlanGrant | null }> {
  const { organizationId, namespace, grants, billing, state } = input;
  const now = input.now ?? new Date();
  const syncLimits = input.syncLimits ?? syncCloudResourceLimits;
  const row = await grants.current(organizationId);
  if (!row) return { ...state, grant: null };
  const grant = resolvePlanGrant(row, organizationId, namespace, now);

  // A real subscription permanently supersedes the grant, even when it later
  // ends. Never rewrite its quota or resurrect free access after cancellation.
  if (state.subscription) {
    subscriptionPlan(state.subscription, organizationId, namespace);
    await grants.release(row.id, "hosted_subscription", now);
    return { ...state, grant: null };
  }

  if (row.revokedAt || (row.expiresAt && row.expiresAt <= now)) {
    await applyGrantPolicy(billing, namespace, { quotaLimit: 0, overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces" });
    await syncLimits(namespace, "free", cloudNamespaceLimits("free"));
    const refreshed = await readProviderBilling(billing, namespace);
    await grants.release(row.id, row.revokedAt ? "revoked" : "expired", now);
    return { ...refreshed, grant: null };
  }

  if (row.appliedPeriodEnd?.getTime() === grant.period.end.getTime()) return { ...state, grant };

  // Persisted intent precedes these calls. setPolicy preserves usage/top-ups;
  // resetQuota is idempotent at the provider, including a crash before markApplied.
  const desired = { quotaLimit: grant.offer.credits, ...grant.policy };
  await applyGrantPolicy(billing, namespace, desired);
  await billing.resetQuota(namespace, grant.period.end.toISOString());
  await syncLimits(namespace, grant.tier, grant.resourceLimits);
  const refreshed = await readProviderBilling(billing, namespace);
  if (refreshed.subscription) {
    subscriptionPlan(refreshed.subscription, organizationId, namespace);
    await grants.release(row.id, "hosted_subscription", now);
    return { ...refreshed, grant: null };
  }
  await grants.markApplied(row.id, grant.period.end);
  return { ...refreshed, grant };
}
