/** Customer billing delegates to Oblien Mode B; no Stripe SDK or credit writes. */
import { createHash } from "node:crypto";
import type { CustomSubscriptionSelection } from "@repo/contracts";
import { AppError, PRICING, type PlanTierId } from "@repo/core";
import { runtimeTarget, env } from "../../config/env";
import type { ExecutionContext as RequestContext } from "../../../context";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { ensureNamespace } from "../../lib/openship-cloud";
import {
  subscriptionOffer,
  subscriptionMetadata,
  topupOffer,
  subscriptionPlan,
} from "./billing-catalog";
import { syncOblienEntitlement, withCloudBillingLock } from "./billing-oblien-quota";
import { listLiveSubscriptions } from "./billing.repository";
import { canStartCloudSubscription, canTopUpCloudSubscription, presentCloudSubscription } from "./billing-subscription";
import { fromOblienCredits } from "./billing-credit-units";
import { cloudAnalytics } from "../cloud-analytics";
import { cloudBillingOwner, type CloudWorkspaceScope } from "../../lib/cloud-workspace-scope";
import { readCloudWorkspaceHost } from "../../lib/cloud-workspace-host";
import { createTrackedWorkspaceCheckout } from "./workspace-checkout";
import { customSubscriptionOffer } from "./billing-custom-offer";

export function assertBillingEnabled(): void {
  if (!env.BILLING_ENABLED) {
    throw new AppError("Billing is not enabled yet. It's coming soon to Openship Cloud.", 403, "BILLING_NOT_ENABLED");
  }
}

export function assertTopupsEnabled(): void {
  assertBillingEnabled();
  if (!env.BILLING_TOPUPS_ENABLED) {
    throw new AppError("One-time credit top-ups are not available yet.", 403, "BILLING_TOPUPS_NOT_ENABLED");
  }
}

function checkoutKey(orgId: string, resource: string, requestKey?: string): string {
  // Scope a caller's key to its authenticated organization and selected purchase.
  // Older clients get a retry window; new clients supply a UUID per purchase.
  const nonce = requestKey ?? String(Math.floor(Date.now() / (15 * 60_000)));
  return "openship:" + createHash("sha256").update(JSON.stringify([orgId, resource, nonce])).digest("hex");
}

async function assertBillingOwnerAvailable(orgId: string, workspaceId?: CloudWorkspaceScope): Promise<void> {
  const owner = await cloudBillingOwner(orgId, workspaceId);
  if (owner.workspace?.deletionInProgress) throw new AppError("This workspace is being deleted", 409, "CLOUD_WORKSPACE_DELETING");

}

export async function createCheckoutSession(
  ctx: RequestContext,
  planTierId: PlanTierId,
  interval: "monthly" | "annual",
  requestKey?: string,
  workspaceId?: CloudWorkspaceScope,
  custom?: CustomSubscriptionSelection,
): Promise<{ checkoutUrl: string }> {
  assertBillingEnabled();
  const customTerms = custom ? customSubscriptionOffer(custom.resources) : null;
  if (customTerms && (interval !== "monthly" || planTierId !== customTerms.quote.basePlanTierId || custom?.quoteReference !== customTerms.quote.reference)) {
    throw new AppError("This resource quote has changed. Refresh the price before continuing to checkout.", 409, "BILLING_QUOTE_CHANGED");
  }
  await assertBillingOwnerAvailable(ctx.organizationId, workspaceId);
  const offer = customTerms?.offer ?? subscriptionOffer(planTierId, interval);
  const namespace = await ensureNamespace(ctx.organizationId, workspaceId);
  const owner = await cloudBillingOwner(ctx.organizationId, workspaceId);
  const selection = owner.workspaceId ? `&workspaceId=${encodeURIComponent(owner.workspaceId)}` : "";
  return withCloudBillingLock(ctx.organizationId, async (sync) => {
    await assertBillingOwnerAvailable(ctx.organizationId, owner.workspaceId);
    const currentOwner = await cloudBillingOwner(ctx.organizationId, owner.workspaceId);
    // Provider-verified state is checked under the same lock as checkout and
    // complimentary grants. A scheduled cancellation is still a paid contract.
    const { grant, subscription } = await sync({ syncResourceLimits: false });
    if (grant) {
      throw new AppError("This workspace has a complimentary plan. Contact support to change it.", 409, "BILLING_COMPLIMENTARY_PLAN");
    }
    if (!canStartCloudSubscription(subscription)) {
      throw new AppError("Contact support to change this server's plan. Your current subscription remains in place; no new charge was created.", 409, "BILLING_PLAN_CHANGE_UNAVAILABLE");
    }
    if (owner.workspace) {
      const { provider } = await readCloudWorkspaceHost(ctx.organizationId, owner.workspace.id);
      const diskGb = offer.resourceLimits?.max_total_disk_gb;
      if (provider && diskGb != null && diskGb * 1024 < provider.allocation.diskMb) {
        throw new AppError("A workspace disk cannot be shrunk in place. Move its data to a smaller workspace before purchasing this plan.", 409, "CLOUD_WORKSPACE_DISK_SHRINK");
      }
    }
    await getOblienBillingApi().assertResellerSupport();
    const result = await createTrackedWorkspaceCheckout(currentOwner.workspace, {
      namespace,
      kind: "subscription",
      offer,
      metadata: { ...subscriptionMetadata(planTierId, ctx.organizationId, namespace, customTerms?.limits), ...(owner.workspaceId ? { openship_workspace: owner.workspaceId } : {}) },
      billingInterval: interval === "annual" ? "yearly" : "monthly",
      successUrl: `${runtimeTarget.dashboard}/billing/overview?checkout=success&tier=${planTierId}&interval=${interval}&offer=${encodeURIComponent(offer.reference!)}&session_id={CHECKOUT_SESSION_ID}${selection}`,
      cancelUrl: `${runtimeTarget.dashboard}/billing/plans?checkout=cancelled${selection}`,
      idempotencyKey: checkoutKey(
        ctx.organizationId,
        `subscription:${owner.workspaceId ? `${namespace}:` : ""}${offer.reference}:${interval}`,
        requestKey,
      ),
    });
    // A checkout redirect is not proof of payment. Webhooks/polling mirror access.
    await cloudAnalytics.checkoutStarted(ctx, { checkoutId: result.checkoutId, kind: "subscription", amount: offer.unitAmount, plan: planTierId, interval });
    return { checkoutUrl: result.url };
  }, owner.workspaceId);
}

export async function createTopupCheckoutSession(ctx: RequestContext, packId: string, requestKey?: string, workspaceId?: CloudWorkspaceScope): Promise<{ checkoutUrl: string }> {
  assertTopupsEnabled();
  await assertBillingOwnerAvailable(ctx.organizationId, workspaceId);
  const offer = topupOffer(packId);
  const namespace = await ensureNamespace(ctx.organizationId, workspaceId);
  const owner = await cloudBillingOwner(ctx.organizationId, workspaceId);
  const selection = owner.workspaceId ? `&workspaceId=${encodeURIComponent(owner.workspaceId)}` : "";
  return withCloudBillingLock(ctx.organizationId, async sync => {
  await assertBillingOwnerAvailable(ctx.organizationId, owner.workspaceId);
  const currentOwner = await cloudBillingOwner(ctx.organizationId, owner.workspaceId);
  const { subscription, entitlement } = await sync({ syncResourceLimits: false });
  if (!canTopUpCloudSubscription(subscription, entitlement)) {
    throw new AppError("An active Cloud subscription is required before adding credits", 402, "CLOUD_PLAN_REQUIRED");
  }
  await getOblienBillingApi().assertResellerSupport();
  const result = await createTrackedWorkspaceCheckout(currentOwner.workspace, {
    namespace,
    kind: "topup",
    offer,
    metadata: {
      openship_organization: ctx.organizationId,
      openship_namespace: namespace,
      ...(owner.workspaceId ? { openship_workspace: owner.workspaceId } : {}),
      openship_pack: packId,
    },
    successUrl: `${runtimeTarget.dashboard}/billing/overview?topup=success&session_id={CHECKOUT_SESSION_ID}${selection}`,
    cancelUrl: `${runtimeTarget.dashboard}/billing/overview?topup=cancelled${selection}`,
    idempotencyKey: checkoutKey(ctx.organizationId, `topup:${owner.workspaceId ? `${namespace}:` : ""}${offer.reference}`, requestKey),
  });
  await cloudAnalytics.checkoutStarted(ctx, { checkoutId: result.checkoutId, kind: "topup", amount: offer.unitAmount });
  return { checkoutUrl: result.url };
  }, owner.workspaceId);
}

export async function listActiveCreditPacks() {
  return PRICING.creditPacks.map((pack) => ({
    id: pack.id,
    name: topupOffer(pack.id).name,
    credits_milli: pack.creditsMilli,
    price_cents: pack.priceCents,
    sortOrder: pack.sortOrder,
    explains: topupOffer(pack.id).description ?? null,
  }));
}

export async function getCheckoutStatus(orgId: string, checkoutId: string, workspaceId?: CloudWorkspaceScope) {
  const namespace = await ensureNamespace(orgId, workspaceId);
  const { checkout } = await getOblienBillingApi().getCheckout(namespace, checkoutId);
  if (checkout.fulfilled) {
    const owner = await cloudBillingOwner(orgId, workspaceId);
    if (owner.workspaceId) {
      await syncOblienEntitlement(orgId, { workspaceId: owner.workspaceId });
      const { requestPaidWorkspaceProvisioning } = await import("../cloud-workspaces/cloud-workspace.service");
      await requestPaidWorkspaceProvisioning(orgId, owner.workspaceId);
    }
  }
  await cloudAnalytics.checkoutObserved(orgId, checkout);
  const { namespaceCreditsGranted, ...state } = checkout;
  return { ...state, creditsGranted: fromOblienCredits(namespaceCreditsGranted) };
}

// Disabling new purchases must not prevent existing customers from stopping
// renewal or managing their invoices/payment details.
export async function createPortalSession(orgId: string, workspaceId?: CloudWorkspaceScope): Promise<{ portalUrl: string }> {
  await assertBillingOwnerAvailable(orgId, workspaceId);
  const namespace = await ensureNamespace(orgId, workspaceId);
  const result = await getOblienBillingApi().createPortal({
    namespace, returnUrl: `${runtimeTarget.dashboard}/billing/overview${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
  });
  return { portalUrl: result.url };
}

export async function cancelSubscription(orgId: string, workspaceId?: CloudWorkspaceScope) {
  await assertBillingOwnerAvailable(orgId, workspaceId);
  const namespace = await ensureNamespace(orgId, workspaceId);
  return withCloudBillingLock(orgId, async () => {
  await assertBillingOwnerAvailable(orgId, workspaceId);
  const result = await getOblienBillingApi().cancelSubscription(namespace);
  subscriptionPlan(result.subscription, orgId, namespace);
  const subscription = presentCloudSubscription(result.subscription);
  if (!subscription || (!subscription.cancelAtPeriodEnd && subscription.status !== "canceled")) {
    throw new AppError("Cloud billing did not confirm cancellation. Please retry.", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
  }
  return { cancelAt: subscription.cancelAtPeriodEnd ? subscription.currentPeriod.end : subscription.canceledAt, subscription };
  }, workspaceId);
}

export async function resumeSubscription(orgId: string, workspaceId?: CloudWorkspaceScope) {
  await assertBillingOwnerAvailable(orgId, workspaceId);
  const namespace = await ensureNamespace(orgId, workspaceId);
  return withCloudBillingLock(orgId, async () => {
  await assertBillingOwnerAvailable(orgId, workspaceId);
  const result = await getOblienBillingApi().resumeSubscription(namespace);
  subscriptionPlan(result.subscription, orgId, namespace);
  const subscription = presentCloudSubscription(result.subscription);
  if (!subscription || subscription.cancelAtPeriodEnd || subscription.status === "canceled") {
    throw new AppError("Cloud billing did not confirm renewal. Please retry.", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
  }
  return { subscription };
  }, workspaceId);
}
