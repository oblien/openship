import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { z } from "zod";
import { repos } from "@repo/db";
import type { PlanTierId } from "@repo/core";
import type { OblienSubscription } from "../../lib/oblien-billing-api";
import { cloudAnalytics } from "./index";

/** Only fields documented in Oblien's reseller payment-event contract. */
const payment = z.object({
  namespace: z.string().optional(),
  paymentId: z.string().min(1).max(256),
  checkoutId: z.string().min(1).max(256).optional(),
  kind: z.enum(["subscription", "topup"]),
  amount: z.object({
    unitAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("usd"),
  }),
  metadata: z.object({ openship_organization: z.string().optional() }).optional(),
});

export async function observeVerifiedBillingEvent(
  organizationId: string,
  eventType: string,
  data: unknown,
  timestamp?: string | number,
): Promise<void> {
  if (!cloudAnalytics.enabled({ organizationId })) return;
  // This function is downstream of raw-body HMAC + namespace resolution. A
  // checkout redirect, entitlement change, or credit grant is never revenue.
  if (eventType === "payment.succeeded" || eventType === "subscription.renewed") {
    const parsed = payment.safeParse(data);
    if (
      parsed.success &&
      (eventType !== "subscription.renewed" || parsed.data.kind === "subscription") &&
      (!parsed.data.metadata?.openship_organization ||
        parsed.data.metadata.openship_organization === organizationId)
    ) {
      const row = parsed.data;
      const date =
        timestamp === undefined
          ? undefined
          : new Date(
              typeof timestamp === "number" && timestamp < 1e12 ? timestamp * 1000 : timestamp,
            );
      const occurredAt =
        date && Number.isFinite(date.getTime()) && date.getTime() <= Date.now() + 300_000
          ? date
          : undefined;
      await cloudAnalytics.payment(
        { organizationId },
        {
          paymentId: row.paymentId,
          checkoutId: row.checkoutId,
          kind: row.kind,
          amount: row.amount.unitAmount,
          renewed: eventType === "subscription.renewed",
        },
        occurredAt,
      );
    }
  }
  // Includes entitlement.changed after a refund/dispute. A namespace-scoped
  // provider lookup supplies the current status; the webhook's payload cannot
  // turn an old checkout into a new payment.
  const checkoutId = (data as { checkoutId?: unknown } | null)?.checkoutId;
  if (typeof checkoutId === "string" && checkoutId.length > 0 && checkoutId.length <= 256) {
    await repos.cloudAnalytics.recheckCheckout(organizationId, checkoutId).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud-analytics/billing");
    });
  }
}

export async function observeCloudSubscription(
  organizationId: string,
  state: { tier: PlanTierId; subscription: OblienSubscription; grant: unknown },
): Promise<void> {
  if (!cloudAnalytics.enabled({ organizationId })) return;
  const subscription = state.subscription;
  const complimentary = !!state.grant;
  const paying = !complimentary && state.tier !== "free" && subscription?.status === "active";
  await cloudAnalytics.subscription(organizationId, {
    plan: state.tier,
    billing_source: complimentary ? "complimentary" : subscription ? "subscription" : "none",
    status: complimentary ? "active" : (subscription?.status ?? "none"),
    ...(subscription &&
      !complimentary && {
        interval:
          subscription.billingInterval === "yearly" ? ("annual" as const) : ("monthly" as const),
      }),
    cancel_at_period_end: !complimentary && !!subscription?.cancelAtPeriodEnd,
    paying,
    mrr_cents: !paying
      ? 0
      : subscription?.offer
        ? subscription.offer.unitAmount / (subscription.billingInterval === "yearly" ? 12 : 1)
        : null,
    currency: "usd",
  });
}
