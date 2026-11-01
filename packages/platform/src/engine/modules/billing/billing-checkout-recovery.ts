import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { createHash } from "node:crypto";
import { AppError } from "@repo/core";
import { repos, type CloudWorkspace } from "@repo/db";
import type {
  BillingCheckoutActionInput,
  BillingCheckoutActionResult,
  BillingPendingCheckout,
  BillingScopeInput,
} from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { requireCloudWorkspace } from "../../lib/cloud-workspace-scope";
import { mapWithLimit } from "../../lib/map-with-limit";
import { withCloudBillingLock } from "./billing-oblien-quota";
import {
  createTrackedWorkspaceCheckout,
  isExpiredCheckout,
  workspaceCheckoutRequest,
} from "./workspace-checkout";

type Intent = CloudWorkspace["pendingCheckouts"][number];
type Checkout = Awaited<
  ReturnType<ReturnType<typeof getOblienBillingApi>["getCheckout"]>
>["checkout"];
const identity = (owner: CloudWorkspace, intent: Intent) =>
  createHash("sha256")
    .update(JSON.stringify([owner.id, intent.request.idempotencyKey]))
    .digest("hex");
const settled = (checkout: Checkout) =>
  checkout.status === "expired" || (checkout.status === "complete" && checkout.fulfilled);
const payable = (checkout: Checkout) =>
  checkout.status === "open" && checkout.paymentStatus === "unpaid" && !checkout.fulfilled;

/** Saved requests provide display terms. Provider reads provide payment state.
 * Listing must not replay a lost create request, start a purchase, or clear an intent. */
export async function listCheckouts(ctx: ExecutionContext, input: BillingScopeInput = {}) {
  const owners = input.workspaceId
    ? [await requireCloudWorkspace(ctx.organizationId, input.workspaceId)]
    : await repos.cloudWorkspace.listByOrganization(ctx.organizationId);
  const billing = getOblienBillingApi();
  let catalogReadFailed = false;
  const genericCancellation = owners.some((owner) =>
    owner.pendingCheckouts.some((intent) => intent.checkoutId && !intent.cancellation),
  )
    ? await billing
        .getCatalog()
        .then((catalog) => catalog.reseller?.checkoutCancellation === true)
        .catch((error) => {
          catalogReadFailed = true;
          observeCaughtError(error, "platform/engine/modules/billing/billing-checkout-recovery");
          return false;
        })
    : false;
  const { summary } = await import("../cloud-workspaces/cloud-workspace.service");
  const rows = await mapWithLimit(
    owners.filter((owner) => owner.pendingCheckouts.length > 0),
    3,
    async (owner) => {
      const server = await summary(owner);
      let capacityReadFailed = false;
      const capacity =
        !genericCancellation &&
        owner.namespace &&
        owner.pendingCheckouts.some(
          (intent) =>
            intent.checkoutId && !intent.cancellation && intent.request.kind === "subscription",
        )
          ? await billing.getPendingCapacityCheckout(owner.namespace).catch((diagnosticFailure) => {
              capacityReadFailed = true;
              observeCaughtError(
                diagnosticFailure,
                "platform/engine/modules/billing/billing-checkout-recovery",
              );
              return null;
            })
          : null;
      return mapWithLimit(
        owner.pendingCheckouts,
        3,
        async (intent): Promise<BillingPendingCheckout | null> => {
          const request = workspaceCheckoutRequest(owner, intent);
          const checkout = intent.checkoutId
            ? await billing
                .getCheckout(owner.namespace!, intent.checkoutId)
                .then((result) => result.checkout)
                .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/billing/billing-checkout-recovery"); return null; })
            : null;
          if (checkout && settled(checkout)) return null;
          const canResume =
            !intent.cancellation && (!intent.checkoutId || Boolean(checkout && payable(checkout)));
          const matchingQuote =
            capacity?.pendingCheckout?.checkoutId === intent.checkoutId &&
            capacity?.pendingCheckout?.quote.paymentSource === "stripe";
          const canCancel = Boolean(
            checkout &&
            payable(checkout) &&
            (intent.cancellation || genericCancellation || matchingQuote),
          );
          const cancelUnavailableReason: BillingPendingCheckout["cancelUnavailableReason"] =
            !canCancel && checkout && payable(checkout) && !intent.cancellation
              ? catalogReadFailed || (capacityReadFailed && request.kind === "subscription")
                ? "provider_unavailable"
                : "unsupported"
              : undefined;
          return {
            id: identity(owner, intent),
            checkoutId: intent.checkoutId ?? null,
            server,
            kind: request.kind,
            name: request.offer.name,
            amountCents: request.offer.unitAmount,
            currency: "usd",
            interval:
              request.kind === "subscription"
                ? request.billingInterval === "yearly"
                  ? "annual"
                  : "monthly"
                : null,
            state: intent.cancellation
              ? "canceling"
              : !intent.checkoutId
                ? "unconfirmed"
                : !checkout
                  ? "unavailable"
                  : payable(checkout)
                    ? "open"
                    : "processing",
            canResume,
            canCancel,
            ...(cancelUnavailableReason ? { cancelUnavailableReason } : {}),
          };
        },
      );
    },
  );
  return { items: rows.flat().filter((row): row is BillingPendingCheckout => row !== null) };
}

async function target(orgId: string, input: BillingCheckoutActionInput) {
  const owner = await requireCloudWorkspace(orgId, input.workspaceId);
  if (owner.deletionInProgress)
    throw new AppError("This server is being deleted", 409, "CLOUD_WORKSPACE_DELETING");
  const intent = owner.pendingCheckouts.find((item) => identity(owner, item) === input.id);
  if (!intent)
    throw new AppError(
      "This payment is no longer pending. Refresh its status.",
      404,
      "BILLING_CHECKOUT_NOT_PENDING",
    );
  return { owner, intent, request: workspaceCheckoutRequest(owner, intent) };
}

async function clearSettled(owner: CloudWorkspace, intent: Intent, checkout: Checkout) {
  if (settled(checkout))
    await repos.cloudWorkspace.setPendingCheckouts(
      owner.id,
      owner.organizationId,
      owner.pendingCheckouts.filter((item) => identity(owner, item) !== identity(owner, intent)),
    );
}

function terminalResult(checkout: Checkout): BillingCheckoutActionResult | null {
  if (checkout.status === "expired")
    return { status: "expired", checkoutId: checkout.id, checkoutUrl: null };
  // A submitted payment may still be unpaid or awaiting fulfillment. The
  // existing checkout-status flow separately verifies payment and readiness.
  if (!payable(checkout))
    return { status: "processing", checkoutId: checkout.id, checkoutUrl: null };
  return null;
}

/** Resumption reuses the exact saved offer, redirects and idempotency key. New
 * pricing, another selected plan, or a browser-supplied payment URL never enter it. */
export async function resumeCheckout(
  ctx: ExecutionContext,
  input: BillingCheckoutActionInput,
): Promise<BillingCheckoutActionResult> {
  return withCloudBillingLock(
    ctx.organizationId,
    async () => {
      const { owner, intent, request } = await target(ctx.organizationId, input);
      if (intent.cancellation)
        throw new AppError(
          "Cancellation is still being confirmed. Retry that cancellation before opening another payment.",
          409,
          "CLOUD_WORKSPACE_CHECKOUT_PENDING",
        );
      const billing = getOblienBillingApi();
      if (intent.checkoutId) {
        const { checkout } = await billing.getCheckout(owner.namespace!, intent.checkoutId);
        const terminal = terminalResult(checkout);
        if (terminal) {
          await clearSettled(owner, intent, checkout);
          return terminal;
        }
        const capacity =
          request.kind === "subscription"
            ? await billing.getPendingCapacityCheckout(owner.namespace!).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/billing/billing-checkout-recovery"); return null; })
            : null;
        if (
          capacity?.pendingCheckout?.checkoutId === intent.checkoutId &&
          capacity.pendingCheckout.url
        )
          return {
            status: "ready",
            checkoutId: intent.checkoutId,
            checkoutUrl: capacity.pendingCheckout.url,
          };
      }
      let result;
      try {
        result = await createTrackedWorkspaceCheckout(owner, request);
      } catch (error) {
        if (isExpiredCheckout(error))
          return { status: "expired", checkoutId: intent.checkoutId ?? null, checkoutUrl: null };
        throw error;
      }
      const { checkout } = await billing.getCheckout(owner.namespace!, result.checkoutId);
      return (
        terminalResult(checkout) ?? {
          status: "ready",
          checkoutId: result.checkoutId,
          checkoutUrl: result.url,
        }
      );
    },
    input.workspaceId,
  );
}

/** Cancel the saved provider checkout (or a legacy capacity quote), then verify the original
 * checkout is terminal. Unknown outcomes remain tracked and block another sale. */
export async function cancelCheckout(
  ctx: ExecutionContext,
  input: BillingCheckoutActionInput,
): Promise<BillingCheckoutActionResult> {
  return withCloudBillingLock(
    ctx.organizationId,
    async () => {
      let { owner, intent } = await target(ctx.organizationId, input);
      if (!intent.checkoutId)
        throw new AppError(
          "Recover this payment before canceling it so its checkout can be identified.",
          409,
          "BILLING_CHECKOUT_UNCONFIRMED",
        );
      const billing = getOblienBillingApi();
      const before = (await billing.getCheckout(owner.namespace!, intent.checkoutId)).checkout;
      const terminal = terminalResult(before);
      if (terminal) {
        await clearSettled(owner, intent, before);
        return terminal;
      }
      if (!intent.cancellation) {
        const genericCancellation = await billing
          .getCatalog()
          .then((catalog) => catalog.reseller?.checkoutCancellation === true)
          .catch((error) => {
            observeCaughtError(error, "platform/engine/modules/billing/billing-checkout-recovery");
            return false;
          });
        let cancellation: NonNullable<Intent["cancellation"]>;
        const idempotencyKey = `openship:cancel:${identity(owner, intent)}`;
        if (genericCancellation) {
          cancellation = { checkoutId: intent.checkoutId, idempotencyKey };
        } else {
          const { pendingCheckout } = await billing.getPendingCapacityCheckout(owner.namespace!);
          if (
            !pendingCheckout ||
            pendingCheckout.checkoutId !== intent.checkoutId ||
            pendingCheckout.quote.paymentSource !== "stripe"
          )
            throw new AppError(
              "The provider has no cancelable checkout for this payment. Resume it, allow it to expire, or contact support.",
              409,
              "BILLING_CHECKOUT_CANCEL_UNAVAILABLE",
            );
          cancellation = { quoteId: pendingCheckout.quote.id, idempotencyKey };
        }
        const pending = owner.pendingCheckouts.map((item) =>
          identity(owner, item) === input.id ? { ...item, cancellation } : item,
        );
        await repos.cloudWorkspace.setPendingCheckouts(owner.id, owner.organizationId, pending);
        owner = { ...owner, pendingCheckouts: pending };
        intent = { ...intent, cancellation };
      }
      let error: unknown;
      try {
        const cancellation = intent.cancellation!;
        if ("checkoutId" in cancellation) {
          if (cancellation.checkoutId !== intent.checkoutId)
            throw new AppError(
              "Saved cancellation does not match this payment",
              409,
              "BILLING_CHECKOUT_IDENTITY_MISMATCH",
            );
          await billing.cancelCheckout(owner.namespace!, cancellation.checkoutId, {
            idempotencyKey: cancellation.idempotencyKey,
          });
        } else {
          await billing.cancelCapacityCheckout(owner.namespace!, cancellation);
        }
      } catch (caught) {
        observeCaughtError(caught, "platform/engine/modules/billing/billing-checkout-recovery");
        error = caught;
      }
      // A concurrent payment or lost cancellation response is resolved by this
      // checkout's provider state, never by assuming that an HTTP error means no charge.
      const after = (await billing.getCheckout(owner.namespace!, intent.checkoutId!)).checkout;
      const result = terminalResult(after);
      if (result) {
        await clearSettled(owner, intent, after);
        return result;
      }
      if (error) throw error;
      return { status: "canceling", checkoutId: intent.checkoutId!, checkoutUrl: null };
    },
    input.workspaceId,
  );
}
