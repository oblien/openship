import { AppError } from "@repo/core";

export const OBLIEN_WEBHOOK_EVENTS = [
  "credits.usage", "credits.low", "credits.depleted", "namespace.quota.threshold",
  "payment.succeeded", "subscription.renewed", "subscription.tier_changed",
  "subscription.past_due", "subscription.canceled", "subscription.updated", "entitlement.changed",
  "namespace.suspended", "namespace.restored",
  "subscription.change.scheduled", "subscription.change.applied", "subscription.change.canceled",
  "subscription.change.payment_required", "subscription.change.failed", "subscription.change.expired",
  "capacity.changed", "capacity.renewed", "capacity.expired", "capacity.payment_required", "capacity.revoked",
  "network.topup_applied", "network.allowance.low", "network.allowance.depleted",
  "storage.retention.payment_required", "storage.retention.paid",
] as const;

export function oblienWebhookUrl(override: string | undefined, apiBase: string): string {
  const url = new URL(override ?? `${apiBase.replace(/\/+$/, "")}/api/billing/oblien-webhook`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new AppError("Configure a public HTTPS OBLIEN_WEBHOOK_URL for Cloud billing", 503, "OBLIEN_WEBHOOK_NOT_CONFIGURED");
  }
  return url.toString();
}
