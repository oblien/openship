/**
 * Oblien quota wrapper — single point of contact for credit-related
 * calls against the Oblien `/credits/namespace-quota` API surface.
 *
 * Everything else that needs to talk to Oblien for credits (Stripe
 * webhooks for tier change / topup, the monthly-reset cron, the
 * `credits.depleted` webhook handler, billing controllers) routes
 * through THIS file. Centralising it here means:
 *
 *   - One place owns the `service` code we bill against
 *     (`SERVICE_CODE = "compute"` per Oblien team) so a typo can't
 *     drift between writers and readers.
 *   - The camelCase param shape (`quotaLimit`) vs the snake_case
 *     persisted shape (`quota_limit`) is mapped exactly once.
 *   - When Oblien renames a field or adds a new param, only this
 *     file touches the SDK.
 *
 * We only ever *configure* Oblien (setQuota + resource_limits) and *read* it
 * back. We do NOT suspend/activate namespaces or otherwise manage resource
 * actions — Oblien owns that: the credit quota's `onOverdraftAction`
 * (`stop_workspaces`) stops workspaces when the overdraft is crossed, and the
 * resource pools block create/start at capacity. Reinventing it here would
 * just race Oblien.
 *
 * Runs server-side under CLOUD_MODE — `getOblienClient()` refuses to
 * instantiate elsewhere. Every helper short-circuits gracefully when
 * the org's `oblien_namespace` hasn't been provisioned yet (returning
 * null / no-op) so callers don't need an extra guard.
 */

import {
  PLANS,
  DEFAULT_PLAN_TIER,
  type PlanDefinition,
  type PlanTierId,
  safeErrorMessage,
} from "@repo/core";
import { repos } from "@repo/db";
import type { NamespaceUsageUnits } from "@repo/adapters";

import { env } from "../../config/env";
import { getOblienClient } from "../../lib/oblien-client";
import {
  toOblienCredits,
  fromOblienCredits,
  OBLIEN_QUOTA_MAX_MILLI,
} from "./billing-credit-units";

/**
 * Canonical credits service code per Oblien team. All quota reads
 * AND writes go through this constant — never inline the literal.
 */
const SERVICE_CODE = "compute";

/** Default threshold percentages at which Oblien fires `namespace.quota.threshold`. */
const QUOTA_NOTIFICATION_THRESHOLDS = [80, 95];
/** Credits of overdraft allowed past the ceiling before enforcement bites. */
const QUOTA_OVERDRAFT = 0;

/**
 * Account-wide default quota, auto-applied by Oblien to any namespace created
 * without an explicit `setQuota`.
 *
 * Defence in depth, not the primary control — `ensureNamespaceWithQuota` is. This
 * exists because "uncapped" is the wrong default for a metered tenant: any future
 * code path that creates a namespace and forgets the quota push should land on the
 * FREE tier's ceiling, not on unlimited. A bug that under-serves a paying customer
 * gets a support ticket; a bug that hands out unmetered compute gets an invoice.
 *
 * Deliberately pinned to the free tier's grant rather than a hand-picked number,
 * so it tracks the catalog instead of drifting from it.
 */
export async function ensureOblienDefaultQuota(): Promise<void> {
  if (!env.CLOUD_MODE) return;

  const freeGrantMilli = PLANS[DEFAULT_PLAN_TIER].monthlyCredits;
  if (freeGrantMilli === null) return; // free is never null, but don't assume it

  try {
    await getOblienClient().namespaces.setDefaultQuota({
      service: SERVICE_CODE,
      quotaLimit: toOblienCredits(freeGrantMilli),
      autoApply: true,
    });
  } catch (err) {
    // Never fatal at boot: this is a backstop, and the real ceiling is pushed
    // per-namespace on the spend path.
    console.warn(
      `[oblien] default quota registration failed (namespaces created without an explicit quota would be UNCAPPED): ${safeErrorMessage(err)}`,
    );
  }
}

// The milli↔Oblien-credit boundary lives in a pure, dependency-free module so
// it's unit-testable in isolation. Re-exported since the webhook controller
// reaches `fromOblienCredits` through this wrapper.
export { toOblienCredits, fromOblienCredits };

/**
 * Re-apply a tier's per-workspace resource ceilings (max_workspaces / vcpus /
 * ram / disk) to the namespace. Enterprise (`oblienLimits === null`) is a
 * no-op — those ceilings are hand-tuned per contract and must not be clobbered.
 * Shared by `setQuotaForTier`/`resetAndRegrant` so a plan change/renewal picks
 * up new caps. `namespaces.update` is idempotent server-side.
 */
/**
 * `organization.plan_tier_id` is a free-text column with no constraint, so a
 * hand-edited row or a tier retired from the catalog can hold a string PLANS has
 * no entry for. A bare `PLANS[tierId]` there is a TypeError thrown INSIDE a
 * Stripe webhook transaction — which rolls the transaction back and makes Stripe
 * retry the same event forever. Resolve to the free tier instead: the safe
 * direction for a quota is the smallest one.
 */
function resolveTier(tierId: PlanTierId): PlanDefinition {
  return PLANS[tierId] ?? PLANS[DEFAULT_PLAN_TIER];
}

async function applyResourceLimits(
  client: ReturnType<typeof getOblienClient>,
  namespace: string,
  tier: PlanDefinition,
): Promise<void> {
  if (!tier.oblienLimits) return;
  try {
    await client.namespaces.update(namespace, {
      resource_limits: tier.oblienLimits,
    });
  } catch (err) {
    // Deliberately NOT rethrown. This runs inside the Stripe webhook
    // transaction, and a throw here rolled back the tier upsert — so a customer
    // who had just paid stayed on their old plan while Stripe redelivered the
    // event forever, and every retry hit the same failing namespace call. The
    // credit quota (set just before this) is the entitlement that matters;
    // resource ceilings are a backstop Oblien re-reads on the next push, and the
    // anniversary cron re-applies them every period. Losing the ceiling for one
    // period is strictly better than never granting the plan the customer bought.
    console.error(
      `[billing] failed to apply ${tier.id} resource_limits to namespace ${namespace} (tier change still applied): ${safeErrorMessage(err)}`,
    );
  }
}

/**
 * Local mirror of the relevant fields off `NamespaceQuota` (Oblien
 * SDK 2.2.37 `dist/types/namespace.d.ts:149-170`). We deliberately
 * narrow to the three counters callers actually need — callers
 * shouldn't be reading `last_threshold_fired` or `enabled` from this
 * wrapper, those are wire-level concerns.
 *
 * `quotaRemaining` is computed (limit − used) and clamped to 0 so
 * UI doesn't have to repeat the math; null limit (unset on Oblien
 * side) means "unlimited" → returned as Infinity for callers that
 * want a single numeric field to gate on.
 */
export interface QuotaState {
  quotaLimit: number | null;
  quotaUsed: number;
  quotaRemaining: number;
}

/**
 * Shape Oblien returns from `getDetails` for the bits we care about.
 * The SDK's `ApiResponse` declares `[key: string]: unknown` so we
 * narrow defensively here rather than casting blind.
 */
interface OblienQuotaRow {
  service?: string;
  quota_limit?: number | null;
  quota_used?: number | null;
}

interface OblienDetailsResponse {
  data?: {
    /** `active` | `suspended` — Oblien's own namespace lifecycle state. */
    status?: string;
    quotas?: OblienQuotaRow[];
  };
}

/** What one reconciliation pass found and corrected for an org. */
export interface EntitlementDrift {
  /** Oblien had no compute quota row at all — the uncapped-tenant case. */
  quotaMissing: boolean;
  /** Oblien's ceiling disagreed with the tier's (in milli-credits). */
  quotaLimitWas: number | null;
  quotaLimitNow: number | null;
  /** Oblien's namespace status, verbatim. */
  oblienStatus: string | null;
  /** Local status before/after the pass. */
  statusWas: string;
  statusNow: string;
  /** True when anything was written. */
  changed: boolean;
}

/**
 * Compare Oblien's truth against ours for ONE org, and correct ours.
 *
 * Why polling exists at all: Oblien states plainly that webhook "delivery is
 * best-effort with idempotent provisioning" and that callers should "reconcile via
 * the entitlement endpoint". Until this existed, a single dropped
 * `credits.depleted` left an org reading `active` forever — silently, permanently,
 * with the customer's workloads stopped and their billing page claiming health.
 * It also covers the two lifecycle events this SDK version cannot subscribe to
 * (`namespace.suspended` / `namespace.restored`).
 *
 * Three drifts are repaired, and the FIRST is the one that matters most:
 *
 *   1. NO QUOTA ROW on Oblien → push the tier's ceiling. This is the uncapped
 *      tenant: a namespace that exists, accrues spend, and has nothing stopping it.
 *      `ensureNamespaceWithQuota` is the primary guard on the spend path; this is
 *      the sweep that catches anything that got in before it, or around it.
 *   2. CEILING MISMATCH → re-push. Covers a manual Oblien edit and a plan change
 *      whose webhook never landed.
 *   3. STATUS DRIFT → align `subscription_status` with Oblien's namespace state.
 *
 * Deliberately does NOT touch `past_due` / `canceled`: those are Stripe's verdict
 * on whether the money arrived, and a namespace being up says nothing about that.
 * Only the status this system owns (`credit_exhausted`) is cleared here.
 *
 * Never throws — one unreachable namespace must not stop a sweep.
 */
export async function reconcileOblienEntitlement(
  orgId: string,
): Promise<EntitlementDrift | null> {
  const org = await repos.organization.findById(orgId).catch(() => null);
  if (!org?.oblienNamespace) return null;

  const tier = resolveTier(org.planTierId as PlanTierId);
  const expected = tier.monthlyCredits; // milli; null = enterprise, uncapped by contract

  let res: OblienDetailsResponse;
  try {
    res = (await getOblienClient().namespaces.getDetails(
      org.oblienNamespace,
    )) as OblienDetailsResponse;
  } catch (err) {
    console.warn(
      `[billing] entitlement reconcile skipped for org ${orgId} (${org.oblienNamespace}): ${safeErrorMessage(err)}`,
    );
    return null;
  }

  const oblienStatus = typeof res?.data?.status === "string" ? res.data.status : null;
  const row = (res?.data?.quotas ?? []).find((q) => q?.service === SERVICE_CODE);
  const limitWas =
    row && typeof row.quota_limit === "number" ? fromOblienCredits(row.quota_limit) : null;

  const drift: EntitlementDrift = {
    quotaMissing: !row,
    quotaLimitWas: limitWas,
    quotaLimitNow: limitWas,
    oblienStatus,
    statusWas: org.subscriptionStatus,
    statusNow: org.subscriptionStatus,
    changed: false,
  };

  // ── 1 + 2: the ceiling ────────────────────────────────────────────────────
  // Enterprise (expected === null) is uncapped by contract, so an absent row is
  // correct there and must not be "repaired" into a cap.
  if (expected !== null && (!row || limitWas !== expected)) {
    try {
      await setQuotaForTier(orgId, tier.id as PlanTierId);
      drift.quotaLimitNow = expected;
      drift.changed = true;
      console.warn(
        `[billing] reconciled Oblien ceiling for org ${orgId} (${org.oblienNamespace}): ` +
          `${drift.quotaMissing ? "MISSING" : String(limitWas)} → ${expected} milli (tier ${tier.id})`,
      );
    } catch (err) {
      console.error(
        `[billing] failed to reconcile ceiling for org ${orgId}: ${safeErrorMessage(err)}`,
      );
    }
  }

  // ── 3: the status ─────────────────────────────────────────────────────────
  const STRIPE_OWNED = ["past_due", "canceled", "cancelled", "unpaid"];
  if (!STRIPE_OWNED.includes(org.subscriptionStatus)) {
    const target =
      oblienStatus === "suspended"
        ? "credit_exhausted"
        : org.subscriptionStatus === "credit_exhausted" && oblienStatus === "active"
          ? "active"
          : null;
    if (target && target !== org.subscriptionStatus) {
      await repos.organization.setSubscriptionStatus(orgId, target).catch(() => {});
      drift.statusNow = target;
      drift.changed = true;
    }
  }

  return drift;
}

/**
 * Read the org's compute quota from Oblien. Returns null when the
 * org hasn't been onboarded to a namespace yet (no `oblien_namespace`
 * column), or when Oblien has no quota row for the compute service
 * on this namespace yet.
 */
export async function getQuotaState(orgId: string): Promise<QuotaState | null> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`getQuotaState: organization ${orgId} not found`);
  }
  if (!org.oblienNamespace) return null;

  const client = getOblienClient();
  let res: OblienDetailsResponse;
  try {
    res = (await client.namespaces.getDetails(org.oblienNamespace)) as OblienDetailsResponse;
  } catch (err) {
    throw new Error(
      `Failed to read Oblien quota for namespace ${org.oblienNamespace} (org ${orgId}): ${safeErrorMessage(err)}`,
    );
  }

  const quotas = res?.data?.quotas ?? [];
  const row = quotas.find((q) => q?.service === SERVICE_CODE);
  if (!row) return null;

  // Oblien reports whole credits; openship state is milli-credits (×1000).
  const quotaLimit =
    typeof row.quota_limit === "number" ? fromOblienCredits(row.quota_limit) : null;
  const quotaUsed =
    typeof row.quota_used === "number" ? fromOblienCredits(row.quota_used) : 0;
  const quotaRemaining =
    quotaLimit === null ? Number.POSITIVE_INFINITY : Math.max(0, quotaLimit - quotaUsed);

  return { quotaLimit, quotaUsed, quotaRemaining };
}

/**
 * Apply a tier's monthly credit allotment as the compute quota on
 * the org's namespace. Idempotent on Oblien's side — repeated calls
 * just overwrite the same row.
 *
 * Enterprise tiers (`monthlyCredits === null`) are no-ops here: their
 * quota is set out-of-band per contract via admin grants, and we
 * don't want to clobber that with a generic ceiling.
 *
 * No-op when the namespace isn't provisioned yet — callers can run
 * this on plan change without needing to gate on namespace state.
 *
 * A larger ceiling automatically lifts Oblien's overdraft `stop_workspaces`
 * gate the moment `quota_used < quota_limit` again — no explicit activate
 * needed on our side (Oblien owns that action).
 */
export async function setQuotaForTier(orgId: string, tierId: PlanTierId): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`setQuotaForTier: organization ${orgId} not found`);
  }
  if (!org.oblienNamespace) return;

  const tier = resolveTier(tierId);
  if (tier.monthlyCredits === null) return;

  const client = getOblienClient();
  try {
    await client.namespaces.setQuota({
      namespace: org.oblienNamespace,
      service: SERVICE_CODE,
      quotaLimit: toOblienCredits(tier.monthlyCredits),
      overdraft: QUOTA_OVERDRAFT,
      onOverdraftAction: "stop_workspaces",
      notificationThresholds: QUOTA_NOTIFICATION_THRESHOLDS,
    });
  } catch (err) {
    throw new Error(
      `Failed to set Oblien quota (${tier.id}) on namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }

  // Re-assert the tier's per-workspace resource ceilings alongside the credit
  // quota so a plan change bumps both in lockstep.
  await applyResourceLimits(client, org.oblienNamespace, tier);
}

/**
 * Add delta credits to the org's current quota ceiling. Used by the
 * topup webhook handler — Stripe charge clears, we want the org's
 * Oblien limit to expand by the pack size without losing the existing
 * tier allotment + accumulated usage.
 *
 * Implementation: read current limit via `getDetails`, then setQuota
 * with the sum. There is no incremental "add" endpoint on Oblien's
 * side. If no row exists yet (fresh namespace), delta becomes the
 * starting ceiling.
 *
 * No-op when the namespace isn't provisioned yet. A topup that lifts the
 * ceiling above usage clears Oblien's overdraft gate automatically.
 */
export async function addQuota(orgId: string, deltaCredits: number): Promise<void> {
  if (deltaCredits <= 0) return;

  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`addQuota: organization ${orgId} not found`);
  }
  if (!org.oblienNamespace) return;

  const state = await getQuotaState(orgId);
  // null state OR null limit (unlimited) → start from 0; otherwise
  // build on what's already there. Unlimited callers shouldn't be
  // calling addQuota in practice, but the safe interpretation is
  // "keep them unlimited" — short-circuit.
  if (state && state.quotaLimit === null) return;

  // Both current + delta are milli-credits. Clamp the sum to Oblien's ceiling
  // (in milli) BEFORE converting so a stack of top-ups grants up to the cap
  // and succeeds rather than tripping toOblienCredits' over-ceiling throw
  // (which would 5xx the Stripe webhook into an infinite retry).
  const current = state?.quotaLimit ?? 0;
  const nextMilli = Math.min(current + deltaCredits, OBLIEN_QUOTA_MAX_MILLI);

  const client = getOblienClient();
  try {
    await client.namespaces.setQuota({
      namespace: org.oblienNamespace,
      service: SERVICE_CODE,
      quotaLimit: toOblienCredits(nextMilli),
      overdraft: QUOTA_OVERDRAFT,
      onOverdraftAction: "stop_workspaces",
      notificationThresholds: QUOTA_NOTIFICATION_THRESHOLDS,
    });
  } catch (err) {
    throw new Error(
      `Failed to add ${deltaCredits} to Oblien quota on namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }
}

/**
 * Anniversary reset: zero the quota_used counter, then re-apply the
 * tier's monthly allotment as the fresh ceiling. Two-step because
 * `resetQuota` doesn't accept a new limit and `setQuota` doesn't zero
 * usage — Oblien splits the concerns.
 *
 * Skips enterprise (monthlyCredits === null) — those orgs are reset
 * out-of-band via admin grant.
 *
 * No-op when the namespace isn't provisioned yet. The fresh (zeroed) usage
 * against the re-applied ceiling clears any Oblien overdraft gate on its own.
 */
export async function resetAndRegrant(orgId: string, tierId: PlanTierId): Promise<void> {
  const org = await repos.organization.findById(orgId);
  if (!org) {
    throw new Error(`resetAndRegrant: organization ${orgId} not found`);
  }
  if (!org.oblienNamespace) return;

  const tier = resolveTier(tierId);
  if (tier.monthlyCredits === null) return;

  const client = getOblienClient();
  try {
    await client.namespaces.resetQuota({
      namespace: org.oblienNamespace,
      service: SERVICE_CODE,
    });
  } catch (err) {
    throw new Error(
      `Failed to reset Oblien quota on namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }

  // Re-apply the tier ceiling after the reset. setQuotaForTier already
  // handles the namespace + enterprise gates, but we've already paid
  // for those lookups — inline the call to avoid the extra DB round
  // trip + duplicate gating.
  try {
    await client.namespaces.setQuota({
      namespace: org.oblienNamespace,
      service: SERVICE_CODE,
      quotaLimit: toOblienCredits(tier.monthlyCredits),
      overdraft: QUOTA_OVERDRAFT,
      onOverdraftAction: "stop_workspaces",
      notificationThresholds: QUOTA_NOTIFICATION_THRESHOLDS,
    });
  } catch (err) {
    throw new Error(
      `Failed to re-apply ${tier.id} quota after reset on namespace ${org.oblienNamespace} for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }

  // Renewal also refreshes resource ceilings (picks up an interim plan bump).
  await applyResourceLimits(client, org.oblienNamespace, tier);
}

/* ------------------------------------------------------------------ */
/* Raw metered usage (buckets + totals)                                */
/* ------------------------------------------------------------------ */

/**
 * Input for `getNamespaceUsage` — the controller hands us already-
 * parsed `Date`s plus an optional bucket size. We marshal to the
 * ISO8601 strings Oblien expects at the boundary so callers don't
 * have to remember the format.
 */
export interface UsageRangeInput {
  organizationId: string;
  from: Date;
  to: Date;
  /** Bucket granularity. Defaults to `"day"` to match Oblien's own default. */
  groupBy?: "hour" | "day";
}

/**
 * Read the raw metered usage-unit rollup for the org's namespace over
 * a time range. Buckets + totals come straight from Oblien — we don't
 * re-derive `vcpu_hours` / `gb_hours` / `credits`, those are part of
 * the SDK contract.
 *
 * Returns `null` when the org hasn't been provisioned a namespace yet
 * (so the dashboard can render an empty state). Throws if Oblien
 * surfaces an error — the controller decides how loudly to fail.
 *
 * Note: response keys are snake_case (`group_by`, `cpu_time_minutes`,
 * …) and we forward them as-is rather than transforming. The chart
 * client already speaks Oblien's vocabulary; renaming here would mean
 * a translation layer at every reader.
 */
export async function getNamespaceUsage(
  input: UsageRangeInput,
): Promise<NamespaceUsageUnits | null> {
  const org = await repos.organization.findById(input.organizationId);
  if (!org) {
    throw new Error(`getNamespaceUsage: organization ${input.organizationId} not found`);
  }
  if (!org.oblienNamespace) return null;

  const client = getOblienClient();
  try {
    const res = await client.namespaces.usageUnits(org.oblienNamespace, {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      groupBy: input.groupBy ?? "day",
    });
    return res.data;
  } catch (err) {
    throw new Error(
      `Failed to read Oblien usage units for namespace ${org.oblienNamespace} (org ${input.organizationId}): ${safeErrorMessage(err)}`,
    );
  }
}
