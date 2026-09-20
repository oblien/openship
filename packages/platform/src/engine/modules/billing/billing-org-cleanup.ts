/** Cloud account closure requires provider confirmation before local deletion. */
import { and, db, eq, inArray, repos, schema } from "@repo/db";
import { env } from "../../config/env";

export interface OrgBillingState {
  activeSubscriptionCount: number;
  /** Unknown for provider-managed accounts; never interpreted as settled. */
  openInvoiceCount: number;
  openInvoiceAmountCents: number;
  blocking: boolean;
  summary: string;
}

export async function getOrgBillingState(organizationId: string): Promise<OrgBillingState> {
  const org = await repos.organization.findById(organizationId);
  const subscriptions = await db.select({ id: schema.billingSubscription.id })
    .from(schema.billingSubscription)
    .where(and(eq(schema.billingSubscription.organizationId, organizationId),
      inArray(schema.billingSubscription.status, ["active", "trialing", "past_due", "unpaid"])));
  // Oblien's entitlement status "canceled" also means an expired Stripe period.
  // It cannot prove cancellation or settled invoices. Deleting local ownership
  // first would orphan the provider namespace and any recurring payments.
  // Also cover onboarding before its background namespace creation finishes.
  const cloudClosure = env.CLOUD_MODE || Boolean(org?.oblienNamespace);
  const legacyBilling = Boolean(org?.stripeCustomerId) || subscriptions.length > 0;
  return {
    activeSubscriptionCount: subscriptions.length,
    openInvoiceCount: 0,
    openInvoiceAmountCents: 0,
    blocking: cloudClosure || legacyBilling,
    summary: cloudClosure
      ? "Contact support to close Cloud billing and remove the Cloud namespace before deleting this organization"
      : legacyBilling
        ? "Contact support to settle or migrate this organization's previous billing account before deletion"
        : "No Cloud billing account",
  };
}
