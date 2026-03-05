import type { Context } from "hono";

/* ---------- Plans ---------- */
export async function listPlans(c: Context) {
  // TODO: Return available pricing plans (free, pro, team, enterprise)
  return c.json({
    data: [
      { id: "free", name: "Free", price: 0, features: ["Self-hosted", "Community support"] },
      { id: "pro", name: "Pro", price: 20, features: ["Cloud hosting", "Custom domains", "Priority support"] },
      { id: "team", name: "Team", price: 50, features: ["All Pro features", "Team management", "SSO"] },
    ],
  });
}

/* ---------- Subscriptions ---------- */
export async function getSubscription(c: Context) {
  return c.json({ data: null });
}

export async function createSubscription(c: Context) {
  // TODO: Create Stripe checkout session
  return c.json({ message: "subscription created" }, 201);
}

export async function updateSubscription(c: Context) {
  // TODO: Upgrade/downgrade plan
  return c.json({ message: "subscription updated" });
}

export async function cancelSubscription(c: Context) {
  // TODO: Cancel at period end
  return c.json({ message: "subscription cancelled" });
}

/* ---------- Usage ---------- */
export async function getUsage(c: Context) {
  // TODO: Return current billing period usage (build minutes, bandwidth, etc.)
  return c.json({ data: { buildMinutes: 0, bandwidth: 0 } });
}

/* ---------- Payment Methods ---------- */
export async function listPaymentMethods(c: Context) {
  return c.json({ data: [] });
}

export async function addPaymentMethod(c: Context) {
  // TODO: Create Stripe setup intent
  return c.json({ message: "payment method added" }, 201);
}

/* ---------- Invoices ---------- */
export async function listInvoices(c: Context) {
  return c.json({ data: [] });
}

/* ---------- Stripe Webhook ---------- */
export async function stripeWebhook(c: Context) {
  // TODO: Verify Stripe signature, handle events
  return c.json({ received: true });
}
