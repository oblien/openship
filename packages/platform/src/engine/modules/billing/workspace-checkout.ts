import { AppError } from "@repo/core";
import { OperationError } from "@repo/contracts";
import { isDeepStrictEqual } from "node:util";
import { repos, type CloudWorkspace } from "@repo/db";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { oblienCheckoutInputSchema, type OblienCheckout } from "../../lib/oblien-billing-api";
import { hasPendingSubscriptionChange } from "./billing-subscription";

export function isExpiredCheckout(error: unknown): boolean {
  return error instanceof OperationError && error.details?.checkoutExpired === true;
}

export function workspaceCheckoutRequest(owner: CloudWorkspace, intent: CloudWorkspace["pendingCheckouts"][number]) {
  const request = oblienCheckoutInputSchema.parse(intent.request);
  if (!owner.namespace || request.namespace !== owner.namespace)
    throw new Error("Checkout namespace does not match its workspace");
  return request;
}

/** Call only under the billing lock. A lost create response is recovered with
 * the exact persisted provider request; it never becomes an untracked charge. */
export async function reconcileWorkspaceCheckouts(owner: CloudWorkspace) {
  const billing = getOblienBillingApi();
  const pending: CloudWorkspace["pendingCheckouts"] = [];
  for (const intent of owner.pendingCheckouts) {
    const request = workspaceCheckoutRequest(owner, intent);
    let checkoutId = intent.checkoutId;
    if (!checkoutId) {
      try {
        checkoutId = (await billing.createCheckout(request)).checkoutId;
      } catch (error) {
        // A scoped replay can expire before its checkout ID was recovered.
        // Only the provider's explicit terminal response releases that intent.
        if (isExpiredCheckout(error)) continue;
        throw error;
      }
    }
    const { checkout } = await billing.getCheckout(owner.namespace!, checkoutId);
    if (checkout.status !== "expired" && !(checkout.status === "complete" && checkout.fulfilled)) {
      pending.push({ ...intent, request, checkoutId });
    }
  }
  if (owner.pendingCheckouts.length)
    await repos.cloudWorkspace.setPendingCheckouts(owner.id, owner.organizationId, pending);
  return pending;
}

/** The namespace remains addressable until all hosted payments are settled. */
export async function assertWorkspaceCheckoutsSettled(owner: CloudWorkspace) {
  if (hasPendingSubscriptionChange(owner.subscriptionChange))
    throw new AppError("Finish or cancel this server's pending plan change first.", 409, "BILLING_PLAN_CHANGE_PENDING");
  if ((await reconcileWorkspaceCheckouts(owner)).length)
    throw new AppError(
      "This workspace has an open or unfinished payment. Complete it or wait for checkout to expire before deleting the workspace.",
      409,
      "CLOUD_WORKSPACE_CHECKOUT_PENDING",
    );
}

export async function createTrackedWorkspaceCheckout(
  owner: CloudWorkspace | undefined,
  request: OblienCheckout,
) {
  const billing = getOblienBillingApi();
  if (!owner) return billing.createCheckout(request);
  const pending = await reconcileWorkspaceCheckouts(owner);
  const existing = pending.find((item) => item.request.idempotencyKey === request.idempotencyKey);
  if (existing && !isDeepStrictEqual(existing.request, request))
    throw new AppError(
      "This checkout request no longer matches its original purchase. Start a new checkout.",
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
    );
  if (existing?.cancellation)
    throw new AppError("This checkout is being canceled. Check its payment status before continuing.", 409, "CLOUD_WORKSPACE_CHECKOUT_PENDING");
  if (!existing) {
    if (request.kind === "subscription" && pending.some(item => item.request.kind === "subscription"))
      throw new AppError("This server already has an unfinished checkout. Resume that payment or wait for it to expire before choosing another plan.", 409, "CLOUD_WORKSPACE_CHECKOUT_PENDING");
    if (pending.length >= 20)
      throw new AppError(
        "Finish an open checkout before starting another purchase",
        409,
        "CLOUD_WORKSPACE_CHECKOUT_PENDING",
      );
    pending.push({ request });
    await repos.cloudWorkspace.setPendingCheckouts(owner.id, owner.organizationId, pending);
  }
  let result;
  try {
    result = await billing.createCheckout(request);
  } catch (error) {
    // Confirmed expiry is terminal even after a lost response. Other refusals
    // release only fresh attempts; an earlier uncertain purchase stays tracked.
    if (
      isExpiredCheckout(error) || (
        !existing && error instanceof OperationError && error.details?.checkoutRejected === true
      )
    ) {
      await repos.cloudWorkspace.setPendingCheckouts(
        owner.id,
        owner.organizationId,
        pending.filter((item) => item.request.idempotencyKey !== request.idempotencyKey),
      );
    }
    throw error;
  }
  if (existing?.checkoutId && result.checkoutId !== existing.checkoutId)
    throw new AppError("Cloud billing returned a different checkout for this purchase", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
  await repos.cloudWorkspace.setPendingCheckouts(
    owner.id,
    owner.organizationId,
    pending.map((item) =>
      item.request.idempotencyKey === request.idempotencyKey
        ? { ...item, checkoutId: result.checkoutId }
        : item,
    ),
  );
  return result;
}
