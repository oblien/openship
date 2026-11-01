import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AppError, safeErrorMessage } from "@repo/core";
import { OperationError, type BillingOperations, type BillingPlanChange, type BillingPlanChangeQuote } from "@repo/contracts";
import { repos, type CloudSubscriptionChangeIntent, type CloudWorkspace } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { oblienPlanChangeInputSchema, type OblienPlanChange, type OblienSubscription } from "../../lib/oblien-billing-api";
import { cloudBillingOwner, requireWorkspaceServer } from "../../lib/cloud-workspace-scope";
import { readCloudWorkspaceHost } from "../../lib/cloud-workspace-host";
import { cloudWorkspaceResourcesFromLimits } from "../../lib/resources";
import { previewWorkspaceResourceChange, applyApprovedWorkspaceResize, requestPaidWorkspaceProvisioning } from "../cloud-workspaces/cloud-workspace.service";
import { withCloudBillingLock } from "./billing-oblien-quota";
import { assertBillingEnabled } from "./billing.service";
import { resolveSubscriptionSelection, subscriptionMetadata, subscriptionPlan } from "./billing-catalog";
import { canChangeCloudSubscription, hasPendingSubscriptionChange, presentChangeOffer, presentSubscriptionChange } from "./billing-subscription";
import { assertWorkspaceCheckoutsSettled } from "./workspace-checkout";

const requestKey = (...parts: string[]) => `openship:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
const terminal = (change: OblienPlanChange) => ["applied", "canceled", "expired", "failed"].includes(change.status);

async function requireOwner(organizationId: string, workspaceId?: string): Promise<CloudWorkspace & { namespace: string }> {
  const { workspace } = await cloudBillingOwner(organizationId, workspaceId);
  if (!workspace || workspace.remote || !workspace.namespace)
    throw new AppError("Select a subscribed managed server before changing its plan", 409, "BILLING_SERVER_REQUIRED");
  if (workspace.deletionInProgress)
    throw new AppError("This server is being deleted", 409, "CLOUD_WORKSPACE_DELETING");
  return { ...workspace, namespace: workspace.namespace };
}

function assertChangeMatchesIntent(change: OblienPlanChange, intent: CloudSubscriptionChangeIntent) {
  const request = oblienPlanChangeInputSchema.parse(intent.request);
  if (change.namespace !== intent.namespace || change.quoteId !== intent.quoteId ||
      !isDeepStrictEqual(change.next, request.offer))
    throw new AppError("Cloud billing returned a different plan change", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
}

async function previewResources(ctx: ExecutionContext, owner: CloudWorkspace, request: CloudSubscriptionChangeIntent["request"]) {
  const { offer } = oblienPlanChangeInputSchema.parse(request);
  const server = await requireWorkspaceServer(ctx.organizationId, owner.id);
  await authorization.authorize(ctx, { resourceType: "server", resourceId: server.id, action: "write" });
  const { provider } = await readCloudWorkspaceHost(ctx.organizationId, owner.id);
  if (!provider) return null;
  const after = cloudWorkspaceResourcesFromLimits(offer.resourceLimits!);
  return previewWorkspaceResourceChange(ctx, owner.id, after);
}

export async function previewSubscriptionChange(ctx: ExecutionContext, input: Parameters<BillingOperations["previewSubscriptionChange"]>[0]): Promise<BillingPlanChangeQuote> {
  assertBillingEnabled();
  const owner = await requireOwner(ctx.organizationId, input.workspaceId);
  await reconcileWorkspaceSubscriptionChange(ctx.organizationId, owner.id);
  return withCloudBillingLock(ctx.organizationId, async sync => {
    const current = await requireOwner(ctx.organizationId, owner.id);
    const { subscription, grant, entitlement } = await sync({ syncResourceLimits: false });
    if (grant || !canChangeCloudSubscription(subscription, entitlement))
      throw new AppError("This subscription cannot change plans now. Resolve its pending payment, cancellation or plan change first.", 409, "BILLING_SUBSCRIPTION_NOT_CHANGEABLE");
    if (hasPendingSubscriptionChange(current.subscriptionChange))
      throw new AppError("The previous plan change is still being confirmed. Refresh its status first.", 409, "BILLING_PLAN_CHANGE_PENDING");
    subscriptionPlan(subscription, ctx.organizationId, owner.namespace);
    await assertWorkspaceCheckoutsSettled(current);
    const interval = subscription!.billingInterval === "yearly" ? "annual" : "monthly";
    const { offer, customLimits } = await resolveSubscriptionSelection(input.planTierId, interval, input.custom);
    if (isDeepStrictEqual(offer, subscription!.offer))
      throw new AppError("This server already has the selected plan", 409, "BILLING_PLAN_UNCHANGED");
    const request = {
      offer, billingInterval: subscription!.billingInterval,
      metadata: { ...subscriptionMetadata(input.planTierId, ctx.organizationId, owner.namespace, customLimits), openship_workspace: owner.id },
      idempotencyKey: requestKey("preview", ctx.organizationId, owner.id, input.idempotencyKey),
    };
    const resize = await previewResources(ctx, current, request);
    await getOblienBillingApi().assertResellerSupport();
    const { quote } = await getOblienBillingApi().previewPlanChange(owner.namespace, request);
    if (!isDeepStrictEqual(quote.next, offer) || !isDeepStrictEqual(quote.current, subscription!.offer))
      throw new AppError("The subscription changed while preparing its price. Review a fresh quote.", 409, "BILLING_QUOTE_CHANGED");
    const intent: CloudSubscriptionChangeIntent = {
      namespace: owner.namespace, request, quoteId: quote.id, expiresAt: quote.expiresAt, resize,
    };
    await repos.cloudWorkspace.setSubscriptionChange(owner.id, ctx.organizationId, intent);
    return {
      id: quote.id, direction: quote.direction, expiresAt: quote.expiresAt, effectiveAt: quote.effectiveAt,
      current: presentChangeOffer(quote.current), next: presentChangeOffer(quote.next),
      interval, currency: quote.currency, amountDueNow: quote.amountDueNow,
      unusedTimeCredit: quote.unusedTimeCredit, remainingTimeCharge: quote.remainingTimeCharge,
      nextInvoiceAmount: quote.nextInvoiceAmount, resize,
    };
  }, owner.id);
}

/** Persist acceptance before any provider call. Confirmation keys are derived
 * from the saved quote, so a browser reload cannot accidentally create a charge. */
export async function confirmSubscriptionChange(ctx: ExecutionContext, input: Parameters<BillingOperations["confirmSubscriptionChange"]>[0]): Promise<BillingPlanChange> {
  assertBillingEnabled();
  const owner = await requireOwner(ctx.organizationId, input.workspaceId);
  const result = await withCloudBillingLock(ctx.organizationId, async () => {
    const current = await requireOwner(ctx.organizationId, owner.id);
    let intent = current.subscriptionChange;
    if (!intent || intent.quoteId !== input.quoteId || intent.namespace !== current.namespace)
      throw new AppError("This quote does not belong to the selected server. Review a fresh quote.", 409, "BILLING_QUOTE_CHANGED");
    if (intent.completed && !intent.changeId)
      throw new AppError("This quote was rejected. Review a fresh quote before confirming.", 409, "BILLING_QUOTE_CHANGED");
    const firstAttempt = !intent.confirmationKey;
    if (!intent.confirmationKey) {
      if (Date.parse(intent.expiresAt) <= Date.now())
        throw new AppError("This quote expired. Review a fresh quote before confirming.", 409, "BILLING_QUOTE_EXPIRED");
      const resize = await previewResources(ctx, current, intent.request);
      if ((resize?.revision ?? null) !== (intent.resize?.revision ?? null))
        throw new AppError("The server or its projects changed. Review a fresh quote before confirming.", 409, "CLOUD_WORKSPACE_CHANGED");
      intent = { ...intent, confirmationKey: requestKey("confirm", ctx.organizationId, owner.id, intent.quoteId) };
      await repos.cloudWorkspace.setSubscriptionChange(owner.id, ctx.organizationId, intent);
    }
    return readAcceptedChange(current, intent, firstAttempt);
  }, owner.id);
  // A payment result is independent from a resize retry. The latter remains a
  // durable server operation and must never cause another payment attempt.
  await reconcileWorkspaceSubscriptionChange(ctx.organizationId, owner.id).catch(error =>
    errorDiagnostics.warn("platform/engine/modules/billing/billing-plan-change", `[cloud-plan-change] ${owner.id}: ${safeErrorMessage(error)}`, error));
  return presentChangeWithServerUpdate(result, await requireOwner(ctx.organizationId, owner.id));
}

/** Caller holds the billing lock. Unknown outcomes retry the original accepted
 * request; only a definite rejection permits a new preview. */
async function readAcceptedChange(owner: CloudWorkspace & { namespace: string }, intent: CloudSubscriptionChangeIntent, firstAttempt = false) {
  if (intent.namespace !== owner.namespace || !intent.confirmationKey)
    throw new Error("Plan-change acceptance does not belong to this server");
  const billing = getOblienBillingApi();
  let change: OblienPlanChange;
  try {
    ({ change } = intent.changeId
      ? await billing.getPlanChange(owner.namespace, intent.changeId)
      : await billing.changePlan(owner.namespace, { quoteId: intent.quoteId, idempotencyKey: intent.confirmationKey }));
  } catch (error) {
    const rejection = error instanceof OperationError ? String(error.details?.providerCode) : null;
    if (!intent.changeId && rejection && (["billing_quote_expired", "billing_quote_changed"].includes(rejection) ||
        (firstAttempt && ["billing_plan_change_pending", "reseller_enterprise_required"].includes(rejection)))) {
      await repos.cloudWorkspace.setSubscriptionChange(owner.id, owner.organizationId, { ...intent, completed: true });
    }
    throw error;
  }
  assertChangeMatchesIntent(change, intent);
  await repos.cloudWorkspace.setSubscriptionChange(owner.id, owner.organizationId, { ...intent, changeId: change.id });
  return change;
}

function presentChangeWithServerUpdate(change: OblienPlanChange, owner: CloudWorkspace): BillingPlanChange {
  const intent = owner.subscriptionChange?.changeId === change.id ? owner.subscriptionChange : null;
  return { ...presentSubscriptionChange(change), ...(intent ? { serverUpdate: intent.serverUpdate ?? "pending" } : {}) };
}

export async function getSubscriptionChange(ctx: ExecutionContext, input: Parameters<BillingOperations["getSubscriptionChange"]>[0]): Promise<BillingPlanChange> {
  const owner = await requireOwner(ctx.organizationId, input.workspaceId);
  const { change } = await getOblienBillingApi().getPlanChange(owner.namespace, input.changeId);
  return presentChangeWithServerUpdate(change, owner);
}

export async function cancelSubscriptionChange(ctx: ExecutionContext, input: Parameters<BillingOperations["cancelSubscriptionChange"]>[0]): Promise<BillingPlanChange> {
  // Stopping a pending purchase stays available even when new sales are disabled.
  const owner = await requireOwner(ctx.organizationId, input.workspaceId);
  const change = await withCloudBillingLock(ctx.organizationId, async () => {
    const current = await requireOwner(ctx.organizationId, owner.id);
    const { change } = await getOblienBillingApi().cancelPlanChange(owner.namespace, input.changeId,
      requestKey("cancel", ctx.organizationId, owner.id, input.changeId));
    if (current.subscriptionChange?.changeId === change.id && terminal(change) && change.status !== "applied")
      await repos.cloudWorkspace.setSubscriptionChange(owner.id, ctx.organizationId, { ...current.subscriptionChange, completed: true });
    return change;
  }, owner.id);
  return presentSubscriptionChange(change);
}

function matchesAppliedSubscription(subscription: OblienSubscription, intent: CloudSubscriptionChangeIntent) {
  const request = oblienPlanChangeInputSchema.parse(intent.request);
  return subscription?.status === "active" && subscription.billingInterval === request.billingInterval &&
    isDeepStrictEqual(subscription.offer, request.offer) &&
    Object.entries(request.metadata).every(([key, value]) => subscription.metadata?.[key] === value);
}

/** Signed events and the existing recovery job share this continuation. Never
 * trust an event's financial payload or resize from a merely accepted payment. */
export async function reconcileWorkspaceSubscriptionChange(organizationId: string, workspaceId: string): Promise<void> {
  const owner = await requireOwner(organizationId, workspaceId);
  if (!owner.subscriptionChange?.confirmationKey || owner.subscriptionChange.completed) return;
  const approved = await withCloudBillingLock(organizationId, async sync => {
    const current = await requireOwner(organizationId, workspaceId);
    const intent = current.subscriptionChange;
    if (!intent?.confirmationKey || intent.completed) return null;
    const change = await readAcceptedChange(current, intent);
    const saved = { ...intent, changeId: change.id };
    if (!terminal(change)) return null;
    if (change.status !== "applied") {
      await repos.cloudWorkspace.setSubscriptionChange(workspaceId, organizationId, { ...saved, completed: true });
      return null;
    }
    const { subscription, grant } = await sync({ syncResourceLimits: false });
    if (grant || !matchesAppliedSubscription(subscription, saved)) {
      // A later plan, refund or cancellation won the race. Never replay its resize.
      await repos.cloudWorkspace.setSubscriptionChange(workspaceId, organizationId, { ...saved, completed: true, serverUpdate: "review_required" });
      return null;
    }
    return saved;
  }, workspaceId);
  if (!approved) return;

  let serverUpdate: NonNullable<CloudSubscriptionChangeIntent["serverUpdate"]>;
  try {
    if (!approved.resize) {
      await requestPaidWorkspaceProvisioning(organizationId, workspaceId);
      serverUpdate = "not_required";
    } else if (isDeepStrictEqual(approved.resize.before, approved.resize.after)) {
      serverUpdate = "not_required";
    } else {
      await applyApprovedWorkspaceResize(organizationId, workspaceId, approved.resize, `plan_${approved.changeId}`);
      serverUpdate = "queued";
    }
  } catch (error) {
    // Busy servers are retried by the existing job. A changed project set or
    // capacity requires fresh restart consent in the shared server UI.
    if (!(error instanceof AppError) || !["CLOUD_WORKSPACE_CHANGED", "CLOUD_WORKSPACE_DISK_SHRINK", "CLOUD_WORKSPACE_NOT_READY"].includes(error.code ?? "")) throw error;
    serverUpdate = "review_required";
  }
  await withCloudBillingLock(organizationId, async () => {
    const current = await requireOwner(organizationId, workspaceId);
    if (current.subscriptionChange?.changeId === approved.changeId)
      await repos.cloudWorkspace.setSubscriptionChange(workspaceId, organizationId, { ...current.subscriptionChange, completed: true, serverUpdate });
  }, workspaceId);
}
