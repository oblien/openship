import { AppError } from "@repo/core";
import { OperationError } from "@repo/contracts";
import { isDeepStrictEqual } from "node:util";
import { repos, type CloudWorkspace } from "@repo/db";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { oblienCheckoutInputSchema, type OblienCheckout } from "../../lib/oblien-billing-api";

/** Call only under the billing lock. A lost create response is recovered with
 * the exact persisted provider request; it never becomes an untracked charge. */
export async function reconcileWorkspaceCheckouts(owner: CloudWorkspace) {
  const billing = getOblienBillingApi();
  const pending: CloudWorkspace["pendingCheckouts"] = [];
  for (const intent of owner.pendingCheckouts) {
    const request = oblienCheckoutInputSchema.parse(intent.request);
    if (request.namespace !== owner.namespace)
      throw new Error("Checkout namespace does not match its workspace");
    const checkoutId = intent.checkoutId ?? (await billing.createCheckout(request)).checkoutId;
    const { checkout } = await billing.getCheckout(owner.namespace!, checkoutId);
    if (checkout.status !== "expired" && !(checkout.status === "complete" && checkout.fulfilled)) {
      pending.push({ request, checkoutId });
    }
  }
  if (owner.pendingCheckouts.length)
    await repos.cloudWorkspace.setPendingCheckouts(owner.id, owner.organizationId, pending);
  return pending;
}

/** The namespace remains addressable until all hosted payments are settled. */
export async function assertWorkspaceCheckoutsSettled(owner: CloudWorkspace) {
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
  if (!existing) {
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
    // Only a fresh, explicitly rejected request is known never to have opened
    // a payment. An earlier lost response must remain tracked for recovery.
    if (
      !existing &&
      error instanceof OperationError &&
      error.statusCode < 500 &&
      [
        "invalid_plan",
        "invalid_pack",
        "invalid_offer",
        "billing_redirect_not_allowed",
        "reseller_enterprise_required",
      ].includes(String(error.details?.providerCode))
    ) {
      await repos.cloudWorkspace.setPendingCheckouts(
        owner.id,
        owner.organizationId,
        pending.filter((item) => item.request.idempotencyKey !== request.idempotencyKey),
      );
    }
    throw error;
  }
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
