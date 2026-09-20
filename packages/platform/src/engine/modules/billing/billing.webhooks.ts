import { AppError } from "@repo/core";

/** Old queued deliveries cannot grant credits or overwrite Oblien entitlements. */
export async function handleStripeEvent(_body: string, _signature?: string): Promise<void> {
  throw new AppError("Direct Stripe billing has been retired; billing is managed by Oblien", 410, "STRIPE_BILLING_RETIRED");
}
