/**
 * Oblien Mode B owns charges, grants, renewals, quotas and suspension.
 * Openship only reads that authority and mirrors application permissions.
 */
import { AppError, safeErrorMessage, type PlanTierId } from "@repo/core";
import { repos } from "@repo/db";
import type { NamespaceUsageUnits } from "@repo/adapters";
import { env } from "../../config/env";
import { getOblienBillingApi, getOblienClient } from "../../lib/oblien-client";
import { assertOblienEntitlementMatchesSubscription, type OblienEntitlement, type OblienSubscription } from "../../lib/oblien-billing-api";
import { createProvisionLock } from "../../lib/provision-lock";
import { syncCloudResourceLimits } from "../../lib/cloud-resource-limits";
import { openshipTier } from "./billing-catalog";
import { fromOblienCredits } from "./billing-credit-units";

export { toOblienCredits, fromOblienCredits } from "./billing-credit-units";

export interface QuotaState {
  quotaLimit: number | null;
  quotaUsed: number;
  quotaRemaining: number | null;
}

export function entitlementQuota(entitlement: OblienEntitlement): QuotaState {
  const { limit, used, balance } = entitlement.quota;
  return {
    quotaLimit: limit === null ? null : fromOblienCredits(limit),
    quotaUsed: fromOblienCredits(used),
    quotaRemaining: balance === null ? null : fromOblienCredits(balance),
  };
}

/** Validate the provider's onboarding policy. Never overwrite paid allowances. */
export async function ensureOblienDefaultQuota(): Promise<void> {
  if (!env.CLOUD_MODE) return;
  const defaults = await getOblienBillingApi().getDefaults();
  if (!defaults.autoApply || defaults.quotaLimit !== 0 || defaults.overdraft !== 0 || defaults.suspendThreshold !== 0 ||
      defaults.onOverdraftAction !== "stop_workspaces") {
    throw new AppError("Cloud onboarding requires an automatically applied zero-credit Oblien policy with no overdraft", 503, "OBLIEN_DEFAULT_POLICY_REQUIRED");
  }
}

export interface EntitlementDrift {
  quotaMissing: boolean;
  statusWas: string;
  statusNow: string;
  changed: boolean;
}

/**
 * Read under an org lock so a delayed webhook cannot overwrite a newer mirror.
 * Events trigger a fresh read; their payloads never authorize credit grants.
 */
export interface SyncedCloudEntitlement {
  entitlement: OblienEntitlement;
  subscription: OblienSubscription;
  tier: PlanTierId;
  drift: EntitlementDrift;
}

interface EntitlementSyncOptions {
  /** Billing reads and checkout do not provision or resize customer workloads. */
  syncResourceLimits?: boolean;
}

/** Shares one lock with webhook deduplication, without nesting pooled DB locks. */
export async function withCloudBillingLock<T>(organizationId: string, work: (
  sync: (options?: EntitlementSyncOptions) => Promise<SyncedCloudEntitlement>,
) => Promise<T>): Promise<T> {
  return createProvisionLock(`billing:entitlement:${organizationId}`).run(() =>
    work(options => readAndMirrorEntitlement(organizationId, options)));
}

export async function syncOblienEntitlement(organizationId: string, options?: EntitlementSyncOptions): Promise<SyncedCloudEntitlement> {
  return withCloudBillingLock(organizationId, (sync) => sync(options));
}

async function readAndMirrorEntitlement(organizationId: string, options: EntitlementSyncOptions = {}): Promise<SyncedCloudEntitlement> {
    const org = await repos.organization.findById(organizationId);
    if (!org?.oblienNamespace) {
      throw new AppError("Cloud namespace is not ready", 503, "CLOUD_NAMESPACE_REQUIRED");
    }
    const billing = getOblienBillingApi();
    const [entitlement, state] = await Promise.all([
      billing.getEntitlement(org.oblienNamespace), billing.getSubscription(org.oblienNamespace),
    ]);
    const tier = openshipTier(entitlement.tierId);
    // A provider may echo the requested namespace while falling back to the
    // API-key owner's tier/period. Verify the namespace's subscription before
    // mirroring paid access or issuing a customer token.
    assertOblienEntitlementMatchesSubscription(entitlement, state.subscription);
    // Positive entitlements must have provider-enforced resource ceilings before
    // issuing a token or allowing another deployment. Exhausted/suspended
    // customers can still obtain management access to stop/delete resources.
    // Reading billing or opening checkout requires no resource-policy write.
    if (options.syncResourceLimits !== false && entitlement.status === "active" && tier !== "free") {
      await syncCloudResourceLimits(org.oblienNamespace, tier);
    }
    const currentPeriodStart = entitlement.periodStart ? new Date(entitlement.periodStart) : null;
    const currentPeriodEnd = entitlement.periodEnd ? new Date(entitlement.periodEnd) : null;
    const changed = org.planTierId !== tier || org.subscriptionStatus !== entitlement.status ||
      (org.currentPeriodStart?.getTime() ?? null) !== (currentPeriodStart?.getTime() ?? null) ||
      (org.currentPeriodEnd?.getTime() ?? null) !== (currentPeriodEnd?.getTime() ?? null);

    if (changed) {
      await repos.organization.setBillingEntitlement(organizationId, org.oblienNamespace, {
        planTierId: tier, subscriptionStatus: entitlement.status, currentPeriodStart, currentPeriodEnd,
      });
    }
    return {
      entitlement, subscription: state.subscription, tier,
      drift: {
        quotaMissing: entitlement.quota.limit === null && tier !== "enterprise",
        statusWas: org.subscriptionStatus, statusNow: entitlement.status, changed,
      },
    };
}

/** A failed read is unknown state, never a free grant or a status transition. */
export async function reconcileOblienEntitlement(orgId: string): Promise<EntitlementDrift | null> {
  try {
    return (await syncOblienEntitlement(orgId)).drift;
  } catch (error) {
    console.warn(`[billing] entitlement reconciliation failed for org ${orgId}: ${safeErrorMessage(error)}`);
    return null;
  }
}

export async function getQuotaState(orgId: string): Promise<QuotaState | null> {
  const org = await repos.organization.findById(orgId);
  if (!org) throw new AppError("Organization not found", 404, "ORGANIZATION_NOT_FOUND");
  if (!org.oblienNamespace) return null;
  return entitlementQuota((await syncOblienEntitlement(orgId, { syncResourceLimits: false })).entitlement);
}

/** Token issuance still allows exhausted customers to inspect and stop workloads. */
export async function assertNamespaceHasQuota(orgId: string): Promise<void> {
  const { drift } = await syncOblienEntitlement(orgId);
  if (drift.quotaMissing) {
    throw new AppError("Cloud namespace billing policy is not ready", 503, "OBLIEN_NAMESPACE_POLICY_REQUIRED");
  }
}

/** Applied immediately before starting new billable work, never before cleanup. */
export async function assertCloudCanSpend(orgId: string): Promise<void> {
  const { entitlement, drift, tier } = await syncOblienEntitlement(orgId);
  // Credits alone (including old top-ups) never activate a Cloud subscription.
  if (tier === "free") {
    throw new AppError("Choose a Cloud plan before building or running workloads", 402, "CLOUD_BILLING_BLOCKED");
  }
  if (drift.quotaMissing) {
    throw new AppError("Cloud namespace billing policy is not ready", 503, "OBLIEN_NAMESPACE_POLICY_REQUIRED");
  }
  const balance = await getOblienBillingApi().getBalance(entitlement.namespace);
  if (entitlement.status !== "active" || balance.blocking || (balance.balance !== null && balance.balance <= 0)) {
    throw new AppError("Your cloud subscription or credit balance needs attention before starting this workload", 402, "CLOUD_BILLING_BLOCKED");
  }
}

// Retired entry points fail closed while old queued Stripe jobs drain. They must
// never write /credits or /billing/policy in an Oblien-managed installation.
function managedBillingOnly(): never {
  throw new AppError("Credit grants and renewals are managed by Oblien", 409, "OBLIEN_MANAGED_BILLING");
}
export async function setQuotaForTier(_orgId: string, _tier: PlanTierId): Promise<void> { managedBillingOnly(); }
export async function addQuota(_orgId: string, _credits: number): Promise<void> { managedBillingOnly(); }
export async function resetAndRegrant(_orgId: string, _tier: PlanTierId): Promise<void> { managedBillingOnly(); }

export interface UsageRangeInput {
  organizationId: string;
  from: Date;
  to: Date;
  groupBy?: "hour" | "day";
}

export async function getNamespaceUsage(input: UsageRangeInput): Promise<NamespaceUsageUnits | null> {
  const org = await repos.organization.findById(input.organizationId);
  if (!org) throw new AppError("Organization not found", 404, "ORGANIZATION_NOT_FOUND");
  if (!org.oblienNamespace) return null;
  const result = await getOblienClient().namespaces.usageUnits(org.oblienNamespace, {
    from: input.from.toISOString(), to: input.to.toISOString(), groupBy: input.groupBy ?? "day",
  });
  if (!result.success || result.data?.namespace !== org.oblienNamespace) {
    throw new AppError("Cloud usage could not be verified for this organization", 502, "OBLIEN_USAGE_NAMESPACE_MISMATCH");
  }
  return result.data;
}
