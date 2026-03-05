/**
 * Billing service — Stripe integration for cloud pricing.
 *
 * Self-hosted instances skip billing entirely (gated by CLOUD_MODE env var).
 */

export async function createCheckoutSession(userId: string, planId: string) {
  // TODO: Create Stripe Checkout session
}

export async function createCustomer(userId: string, email: string) {
  // TODO: Create Stripe customer
}

export async function getSubscription(userId: string) {
  // TODO: Fetch active subscription from DB
}

export async function cancelSubscription(subscriptionId: string) {
  // TODO: Cancel Stripe subscription at period end
}

export async function recordUsage(userId: string, metric: string, quantity: number) {
  // TODO: Record metered usage for billing
}

export async function getUsageSummary(userId: string) {
  // TODO: Aggregate usage for current billing period
}

export async function handleStripeEvent(event: unknown) {
  // TODO: Handle subscription.created, invoice.paid, etc.
}
