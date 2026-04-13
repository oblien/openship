import type { Context } from "hono";
import { PLANS, PLAN_IDS, ANNUAL_DISCOUNT } from "@repo/core";
import { getUserId } from "../../lib/controller-helpers";
import { createSubscriptionSchema } from "./billing.schema";
import * as billingService from "./billing.service";

/* ---------- Plans ---------- */

export async function listPlans(c: Context) {
  const plans = PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return {
      id,
      name: p.name,
      description: p.description,
      popular: p.popular,
      monthlyPrice: p.price,
      annualPrice: p.price === 0 ? 0 : Math.round(p.price * (1 - ANNUAL_DISCOUNT)),
      limits: {
        projects: p.projects,
        deploymentsPerMonth: p.deploymentsPerMonth,
        customDomains: p.customDomains,
        teamMembers: p.teamMembers,
        buildMinutes: p.buildMinutes,
        bandwidth: p.bandwidth,
      },
      support: p.support,
      features: p.features,
    };
  });

  return c.json({
    data: {
      plans,
      annualDiscount: ANNUAL_DISCOUNT,
    },
  });
}

/* ---------- Subscriptions ---------- */

export async function getSubscription(c: Context) {
  const userId = getUserId(c);
  const subscription = await billingService.getSubscription(userId);
  return c.json({ data: subscription });
}

export async function createSubscription(c: Context) {
  const userId = getUserId(c);
  const user = c.get("user");
  const body = await c.req.json();
  const { planId, interval } = createSubscriptionSchema.parse(body);

  const { checkoutUrl } = await billingService.createCheckoutSession(
    userId,
    user?.email,
    planId,
    interval,
  );

  return c.json({ data: { checkoutUrl } }, 201);
}

export async function updateSubscription(c: Context) {
  const userId = getUserId(c);
  const { portalUrl } = await billingService.createPortalSession(userId);
  return c.json({ data: { portalUrl } });
}

export async function cancelSubscription(c: Context) {
  const userId = getUserId(c);
  await billingService.cancelSubscription(userId);
  return c.json({ message: "Subscription cancelled" });
}

/* ---------- Usage ---------- */

export async function getUsage(c: Context) {
  const userId = getUserId(c);
  const usage = await billingService.getUsageSummary(userId);
  return c.json({ data: usage });
}

/* ---------- Payment Methods ---------- */

export async function listPaymentMethods(c: Context) {
  return c.json({ data: [] });
}

export async function addPaymentMethod(c: Context) {
  return c.json({ message: "payment method added" }, 201);
}

/* ---------- Invoices ---------- */

export async function listInvoices(c: Context) {
  return c.json({ data: [] });
}

/* ---------- Stripe Webhook ---------- */

export async function stripeWebhook(c: Context) {
  const signature = c.req.header("stripe-signature");
  const rawBody = await c.req.text();
  await billingService.handleStripeEvent(rawBody, signature);
  return c.json({ received: true });
}
