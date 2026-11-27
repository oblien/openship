import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AppError } from "@repo/core";
import { OperationError, type BillingPlanChangeQuote } from "@repo/contracts";
import type { CloudSubscriptionChangeIntent } from "@repo/db";
import { getOblienBillingApi } from "../../lib/oblien-client";
import {
  oblienPlanChangeInputSchema,
  type OblienPlanChangeInput,
  type OblienOffer,
  type OblienSubscription,
  type OblienPlanChange,
} from "../../lib/oblien-billing-api";
import { presentChangeOffer } from "./billing-subscription";

type Intent = CloudSubscriptionChangeIntent;
type SaveIntent = (intent: Intent) => Promise<unknown>;
export const requestKey = (...parts: string[]) =>
  `openship:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
export const terminal = (change: OblienPlanChange) =>
  ["applied", "canceled", "expired", "failed"].includes(change.status);

function assertChangeMatchesIntent(
  change: OblienPlanChange,
  intent: CloudSubscriptionChangeIntent,
) {
  const request = oblienPlanChangeInputSchema.parse(intent.request);
  if (
    change.namespace !== intent.namespace ||
    change.quoteId !== intent.quoteId ||
    !isDeepStrictEqual(change.next, request.offer)
  )
    throw new AppError(
      "Cloud billing returned a different plan change",
      502,
      "OBLIEN_BILLING_INVALID_RESPONSE",
    );
}

export function matchesAppliedSubscription(
  subscription: OblienSubscription,
  intent: CloudSubscriptionChangeIntent,
) {
  const request = oblienPlanChangeInputSchema.parse(intent.request);
  return (
    subscription?.status === "active" &&
    subscription.billingInterval === request.billingInterval &&
    isDeepStrictEqual(subscription.offer, request.offer) &&
    Object.entries(request.metadata).every(([key, value]) => subscription.metadata?.[key] === value)
  );
}

export async function previewChange(
  namespace: string,
  currentOffer: OblienOffer,
  request: OblienPlanChangeInput,
  resize: Intent["resize"],
  save: SaveIntent,
): Promise<BillingPlanChangeQuote> {
  const { quote } = await getOblienBillingApi().previewPlanChange(namespace, request);
  if (
    !isDeepStrictEqual(quote.next, request.offer) ||
    !isDeepStrictEqual(quote.current, currentOffer)
  )
    throw new AppError(
      "The subscription changed while preparing its price. Review a fresh quote.",
      409,
      "BILLING_QUOTE_CHANGED",
    );
  const intent: CloudSubscriptionChangeIntent = {
    namespace: namespace,
    request,
    quoteId: quote.id,
    expiresAt: quote.expiresAt,
    resize,
  };
  await save(intent);
  return {
    id: quote.id,
    direction: quote.direction,
    expiresAt: quote.expiresAt,
    effectiveAt: quote.effectiveAt,
    current: presentChangeOffer(quote.current),
    next: presentChangeOffer(quote.next),
    interval: request.billingInterval === "yearly" ? "annual" : "monthly",
    currency: quote.currency,
    amountDueNow: quote.amountDueNow,
    unusedTimeCredit: quote.unusedTimeCredit,
    remainingTimeCharge: quote.remainingTimeCharge,
    nextInvoiceAmount: quote.nextInvoiceAmount,
    resize,
  };
}

export async function acceptChange(
  namespace: string,
  ownerKey: string[],
  intent: Intent | null | undefined,
  quoteId: string,
  previewResize: (intent: Intent) => Promise<Intent["resize"]>,
  save: SaveIntent,
) {
  if (!intent || intent.quoteId !== quoteId || intent.namespace !== namespace)
    throw new AppError(
      "This quote does not belong to the selected subscription. Review a fresh quote.",
      409,
      "BILLING_QUOTE_CHANGED",
    );
  if (intent.completed && !intent.changeId)
    throw new AppError(
      "This quote was rejected. Review a fresh quote before confirming.",
      409,
      "BILLING_QUOTE_CHANGED",
    );
  const firstAttempt = !intent.confirmationKey;
  if (!intent.confirmationKey) {
    if (Date.parse(intent.expiresAt) <= Date.now())
      throw new AppError(
        "This quote expired. Review a fresh quote before confirming.",
        409,
        "BILLING_QUOTE_EXPIRED",
      );
    const resize = await previewResize(intent);
    if ((resize?.revision ?? null) !== (intent.resize?.revision ?? null))
      throw new AppError(
        "The server or its projects changed. Review a fresh quote before confirming.",
        409,
        "CLOUD_WORKSPACE_CHANGED",
      );
    intent = { ...intent, confirmationKey: requestKey("confirm", ...ownerKey, intent.quoteId) };
    await save(intent);
  }
  return readAcceptedChange(namespace, intent, save, firstAttempt);
}

export async function readAcceptedChange(
  namespace: string,
  intent: CloudSubscriptionChangeIntent,
  save: SaveIntent,
  firstAttempt = false,
) {
  if (intent.namespace !== namespace || !intent.confirmationKey)
    throw new Error("Plan-change acceptance does not belong to this server");
  const billing = getOblienBillingApi();
  let change: OblienPlanChange;
  try {
    ({ change } = intent.changeId
      ? await billing.getPlanChange(namespace, intent.changeId)
      : await billing.changePlan(namespace, {
          quoteId: intent.quoteId,
          idempotencyKey: intent.confirmationKey,
        }));
  } catch (error) {
    const rejection = error instanceof OperationError ? String(error.details?.providerCode) : null;
    if (
      !intent.changeId &&
      rejection &&
      (["billing_quote_expired", "billing_quote_changed"].includes(rejection) ||
        (firstAttempt &&
          ["billing_plan_change_pending", "reseller_enterprise_required"].includes(rejection)))
    ) {
      await save({ ...intent, completed: true });
    }
    throw error;
  }
  assertChangeMatchesIntent(change, intent);
  await save({ ...intent, changeId: change.id });
  return change;
}
