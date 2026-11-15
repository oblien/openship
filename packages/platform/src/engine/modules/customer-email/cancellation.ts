import type { CustomerCancellationEmail } from "@repo/db/repos";
import type { OblienSubscription } from "../../lib/oblien-billing-api";

/** Provider truth, shared by enqueue and delivery. Resuming or replacing a
 * subscription invalidates a queued goodbye; unrelated updates cannot create it. */
export function subscriptionCancellation(
  subscription: OblienSubscription,
): Pick<CustomerCancellationEmail, "canceledAt" | "endsAt"> | null {
  if (!subscription || (!subscription.cancelAtPeriodEnd && subscription.status !== "canceled"))
    return null;
  const canceledAt = Date.parse(subscription.canceledAt ?? "");
  if (!Number.isFinite(canceledAt)) return null;
  if (subscription.status === "canceled")
    return { canceledAt: new Date(canceledAt).toISOString(), endsAt: null };
  const endsAt = Date.parse(subscription.periodEnd ?? "");
  return Number.isFinite(endsAt)
    ? { canceledAt: new Date(canceledAt).toISOString(), endsAt: new Date(endsAt).toISOString() }
    : null;
}
