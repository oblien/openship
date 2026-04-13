import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as billingController from "./billing.controller";

/**
 * Plan info — no Stripe required, works on ALL instances.
 * Registered at `/api/billing` on every deploy mode.
 */
export const billingPlansRoutes = new Hono();
billingPlansRoutes.get("/plans", billingController.listPlans);

/**
 * Stripe-powered billing — SaaS only (CLOUD_MODE=true).
 * Registered at `/api/billing` only when CLOUD_MODE.
 */
export const billingSaasRoutes = new Hono();

billingSaasRoutes.use("*", async (c, next) => {
  if (c.req.path.endsWith("/webhook/stripe")) return next();
  return authMiddleware(c, next);
});

billingSaasRoutes.get("/subscription", billingController.getSubscription);
billingSaasRoutes.post("/subscription", billingController.createSubscription);
billingSaasRoutes.patch("/subscription", billingController.updateSubscription);
billingSaasRoutes.delete("/subscription", billingController.cancelSubscription);

billingSaasRoutes.get("/usage", billingController.getUsage);

billingSaasRoutes.get("/payment-methods", billingController.listPaymentMethods);
billingSaasRoutes.post("/payment-methods", billingController.addPaymentMethod);

billingSaasRoutes.get("/invoices", billingController.listInvoices);

billingSaasRoutes.post("/webhook/stripe", billingController.stripeWebhook);
