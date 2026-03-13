import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as billingController from "./billing.controller";

export const billingRoutes = new Hono();

// Auth required for all billing routes except webhook
billingRoutes.use("*", async (c, next) => {
  // Stripe webhook uses signature verification, not session auth
  if (c.req.path.endsWith("/webhook/stripe")) return next();
  return authMiddleware(c, next);
});

/* ---------- Plans & Pricing ---------- */
billingRoutes.get("/plans", billingController.listPlans);

/* ---------- Subscriptions ---------- */
billingRoutes.get("/subscription", billingController.getSubscription);
billingRoutes.post("/subscription", billingController.createSubscription);
billingRoutes.patch("/subscription", billingController.updateSubscription);
billingRoutes.delete("/subscription", billingController.cancelSubscription);

/* ---------- Usage ---------- */
billingRoutes.get("/usage", billingController.getUsage);

/* ---------- Payment Methods ---------- */
billingRoutes.get("/payment-methods", billingController.listPaymentMethods);
billingRoutes.post("/payment-methods", billingController.addPaymentMethod);

/* ---------- Invoices ---------- */
billingRoutes.get("/invoices", billingController.listInvoices);

/* ---------- Stripe Webhook (no auth) ---------- */
billingRoutes.post("/webhook/stripe", billingController.stripeWebhook);
