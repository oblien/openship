/**
 * Billing service — Stripe integration for cloud pricing.
 *
 * Self-hosted instances skip billing entirely (gated by CLOUD_MODE env var).
 */

import Stripe from "stripe";
import { PLANS, ANNUAL_DISCOUNT, type PlanId } from "@repo/core";
import { env } from "../../config/env";

/* ---------- Stripe client (lazy) ---------- */

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
    }
    _stripe = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

/* ---------- Checkout ---------- */

export async function createCheckoutSession(
  userId: string,
  email: string | undefined,
  planId: PlanId,
  interval: "monthly" | "annual",
): Promise<{ checkoutUrl: string }> {
  const stripe = getStripe();
  const plan = PLANS[planId];

  if (plan.price === 0) {
    throw new Error("Cannot create checkout for the free plan");
  }

  const unitAmount =
    interval === "annual"
      ? Math.round(plan.price * (1 - ANNUAL_DISCOUNT) * 100)
      : plan.price * 100;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: email,
    client_reference_id: userId,
    metadata: { userId, planId, interval },
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Openship ${plan.name}`,
            description: `${plan.name} plan — ${interval} billing`,
          },
          unit_amount: unitAmount,
          recurring: {
            interval: interval === "annual" ? "year" : "month",
          },
        },
        quantity: 1,
      },
    ],
    success_url: `${env.DASHBOARD_URL}/billing/overview?checkout=success`,
    cancel_url: `${env.DASHBOARD_URL}/billing/plans?checkout=cancelled`,
  });

  if (!session.url) {
    throw new Error("Failed to create checkout session");
  }

  return { checkoutUrl: session.url };
}

/* ---------- Portal ---------- */

export async function createPortalSession(
  userId: string,
): Promise<{ portalUrl: string }> {
  const stripe = getStripe();

  // TODO: Look up Stripe customer ID from DB using userId
  const customerId = ""; // placeholder

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.DASHBOARD_URL}/billing/overview`,
  });

  return { portalUrl: session.url };
}

/* ---------- Customer ---------- */

export async function createCustomer(userId: string, email: string) {
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    metadata: { userId },
  });
  return customer;
}

/* ---------- Subscription ---------- */

export async function getSubscription(userId: string) {
  // TODO: Fetch active subscription from DB by userId
  return null;
}

export async function cancelSubscription(userId: string) {
  // TODO: Look up Stripe subscription ID from DB, cancel at period end
  const stripe = getStripe();
  const subscriptionId = ""; // placeholder — look up from DB
  await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

/* ---------- Usage ---------- */

export async function recordUsage(userId: string, metric: string, quantity: number) {
  // TODO: Record metered usage for billing
}

export async function getUsageSummary(userId: string) {
  // TODO: Aggregate usage for current billing period
  return { buildMinutes: 0, bandwidth: 0, deployments: 0 };
}

/* ---------- Webhook ---------- */

export async function handleStripeEvent(rawBody: string, signature?: string) {
  const stripe = getStripe();

  if (!env.STRIPE_WEBHOOK_SECRET || !signature) {
    throw new Error("Webhook signature verification failed");
  }

  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const { userId, planId } = session.metadata ?? {};
      // TODO: Create subscription record in DB
      console.log("[billing] checkout completed", { userId, planId });
      break;
    }
    case "invoice.paid": {
      // TODO: Record successful payment
      break;
    }
    case "customer.subscription.updated": {
      // TODO: Sync subscription status to DB
      break;
    }
    case "customer.subscription.deleted": {
      // TODO: Mark subscription as cancelled in DB
      break;
    }
  }
}
