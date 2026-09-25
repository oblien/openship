/** Trusted operator workflow. No HTTP route, tenant token, or user metadata can call it. */
import { AppError, generateId, planLimits, type PlanTierId } from "@repo/core";
import type { BillingPlanGrantRepo } from "@repo/db/factory";
import type { OblienBillingApi } from "../../lib/oblien-billing-api";
import { subscriptionOffer } from "./billing-catalog";
import { cloudBillingLockKey, effectiveCloudPlan, readProviderBilling, reconcilePlanGrant, resolvePlanGrant } from "./billing-plan-grants";

export interface PlanGrantCommand {
  command: "grant" | "show" | "revoke";
  email: string;
  organizationId?: string;
  plan: PlanTierId;
  expiresAt: Date | null;
  operator: string;
  reason: string;
  dryRun: boolean;
}

export async function runPlanGrantCommand(args: PlanGrantCommand, deps: {
  grants: BillingPlanGrantRepo;
  billing: OblienBillingApi;
  lock<T>(key: string, work: () => Promise<T>): Promise<T>;
  now?: Date;
  syncLimits?: Parameters<typeof reconcilePlanGrant>[0]["syncLimits"];
}) {
  const { grants, billing } = deps;
  const matches = await grants.ownedOrganizations(args.email.trim());
  if (new Set(matches.map(row => row.userId)).size > 1) {
    throw new AppError("Multiple users match this email; resolve the duplicate accounts first", 409, "BILLING_GRANT_USER_AMBIGUOUS");
  }
  const candidates = args.organizationId ? matches.filter(row => row.organizationId === args.organizationId) : matches;
  const personal = candidates.filter(row => !row.isTeam);
  const target = candidates.length === 1 ? candidates[0] : !args.organizationId && personal.length === 1 ? personal[0] : undefined;
  if (!target) {
    throw new AppError(matches.length
      ? `Choose an owned workspace with --organization. Available: ${matches.map(row => `${row.organizationId} (${row.name})`).join(", ")}`
      : "No owned workspace was found for this email on this instance", 400, "BILLING_GRANT_WORKSPACE_REQUIRED");
  }
  if (!target.namespace) throw new AppError("Open this workspace's Cloud billing once to provision its namespace", 409, "CLOUD_NAMESPACE_REQUIRED");
  const namespace = target.namespace;

  return deps.lock(cloudBillingLockKey(target.organizationId), async () => {
    const lockedTarget = (await grants.ownedOrganizations(args.email.trim())).find(row =>
      row.userId === target.userId && row.organizationId === target.organizationId);
    if (lockedTarget?.namespace !== namespace) {
      throw new AppError("Workspace ownership or namespace changed; retry the command", 409, "BILLING_GRANT_WORKSPACE_CHANGED");
    }
    const now = deps.now ?? new Date();
    const state = await readProviderBilling(billing, namespace);
    let row = await grants.current(target.organizationId);
    const base = { email: target.email, organizationId: target.organizationId, workspace: target.name, namespace };

    if (args.command === "grant") {
      if (!args.reason.trim() || !args.operator.trim()) throw new AppError("A reason and operator are required", 400, "BILLING_GRANT_REASON_REQUIRED");
      if (args.expiresAt && (!Number.isFinite(args.expiresAt.getTime()) || args.expiresAt <= now)) {
        throw new AppError("--expires must be a future ISO timestamp", 400, "BILLING_GRANT_EXPIRY_INVALID");
      }
      // Also validates that this tier has a finite monthly allowance in the catalog.
      const offer = subscriptionOffer(args.plan, "monthly");
      if (state.subscription || await grants.hasLegacySubscription(target.organizationId)) {
        throw new AppError("This workspace already has a subscription. Complimentary grants do not replace paid billing.", 409, "BILLING_GRANT_SUBSCRIPTION_EXISTS");
      }
      if (row && (row.planTierId !== args.plan || row.revokedAt || (row.expiresAt?.getTime() ?? null) !== (args.expiresAt?.getTime() ?? null))) {
        throw new AppError("A different grant exists. Revoke it before issuing another plan or duration.", 409, "BILLING_GRANT_CONFLICT");
      }
      if (args.dryRun) return {
        ...base, dryRun: true, action: row ? "reuse" : "grant", plan: args.plan,
        charge: 0, monthlyCredits: row ? resolvePlanGrant(row, target.organizationId, namespace, now).offer.credits : offer.credits,
        expiresAt: args.expiresAt?.toISOString() ?? null,
      };
      if (!row) {
        row = await grants.create({
          id: generateId("bpg"), organizationId: target.organizationId, namespace,
          planTierId: args.plan, offer, limits: planLimits(args.plan),
          grantedBy: args.operator.trim(), reason: args.reason.trim(), createdAt: now, expiresAt: args.expiresAt,
        });
      }
    } else if (args.command === "show" || args.dryRun) {
      const latest = row ?? await grants.latest(target.organizationId);
      return {
        ...base, dryRun: args.dryRun, action: args.command,
        provider: { tier: state.entitlement.tierId, status: state.entitlement.status, quota: state.entitlement.quota, hasSubscription: Boolean(state.subscription) },
        grant: latest ? {
          id: latest.id, plan: latest.planTierId, grantedBy: latest.grantedBy, reason: latest.reason,
          createdAt: latest.createdAt.toISOString(), expiresAt: latest.expiresAt?.toISOString() ?? null,
          revokedAt: latest.revokedAt?.toISOString() ?? null, releasedAt: latest.releasedAt?.toISOString() ?? null,
          appliedPeriodEnd: latest.appliedPeriodEnd?.toISOString() ?? null,
        } : null,
      };
    } else if (row) {
      await grants.revoke(row.id, args.operator, now);
    }

    const resolved = await reconcilePlanGrant({
      organizationId: target.organizationId, namespace, grants, billing, state, now, syncLimits: deps.syncLimits,
    });
    const access = effectiveCloudPlan(resolved, resolved.grant, target.organizationId);
    await grants.mirror(target.organizationId, namespace, {
      planTierId: access.tier, subscriptionStatus: resolved.entitlement.status,
      currentPeriodStart: access.currentPeriodStart, currentPeriodEnd: access.currentPeriodEnd,
    });
    const balance = await billing.getBalance(namespace);
    return {
      ...base, action: args.command, plan: access.tier, status: resolved.entitlement.status,
      charge: 0, grantId: resolved.grant?.id ?? null,
      monthlyCredits: resolved.grant?.offer.credits ?? null,
      remainingCredits: balance.balance, spendingBlocked: balance.blocking,
      nextRenewal: resolved.grant?.period.end.toISOString() ?? null,
      expiresAt: resolved.grant?.expiresAt?.toISOString() ?? null,
    };
  });
}
