/**
 * Local billing proxy — runs only when !CLOUD_MODE.
 *
 * Proxies subscription/payment/invoice operations to the SaaS API
 * using the user's stored cloud session token (via cloudBillingFetch).
 *
 * Plan listing (GET /plans) is handled by billingPlansRoutes which
 * runs on ALL instances — no proxy needed for that.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as billingLocal from "./billing-local.controller";

export const billingLocalRoutes = new Hono();

billingLocalRoutes.use("*", authMiddleware);

/* ---------- Subscriptions ---------- */
billingLocalRoutes.get("/subscription", billingLocal.getSubscription);
billingLocalRoutes.post("/subscription", billingLocal.createSubscription);
billingLocalRoutes.patch("/subscription", billingLocal.updateSubscription);
billingLocalRoutes.delete("/subscription", billingLocal.cancelSubscription);

/* ---------- Usage ---------- */
billingLocalRoutes.get("/usage", billingLocal.getUsage);

/* ---------- Payment Methods ---------- */
billingLocalRoutes.get("/payment-methods", billingLocal.listPaymentMethods);
billingLocalRoutes.post("/payment-methods", billingLocal.addPaymentMethod);

/* ---------- Invoices ---------- */
billingLocalRoutes.get("/invoices", billingLocal.listInvoices);
