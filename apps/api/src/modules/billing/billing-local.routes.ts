/**
 * Local billing proxy — runs only when !CLOUD_MODE.
 *
 * Mirrors the SaaS billing surface (`billingSaasRoutes`) by proxying
 * to the SaaS API using the caller's stored cloud session token (via
 * cloudFetch). Each proxy call carries the caller's identity — there
 * is no shared admin token. Without a stored cloud session the proxy
 * returns 403 `{ code: "cloud_not_connected" }` so the dashboard can
 * render an accurate empty state.
 *
 * Plan listing (GET /plans) is handled by billingPlansRoutes which
 * runs on ALL instances — no proxy needed for that.
 */

import { Hono } from "hono";
import { CreateSubscriptionBody, CreateTopupBody } from "@repo/contracts";
import { authMiddleware } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as billingLocal from "./billing.controller";

export const billingLocalRoutes = new Hono();
const r = secureRouter(billingLocalRoutes, {
  module: "billing-local",
  basePath: "/api/billing",
});

// ⚠ Same prefix collision as billingSaasRoutes — billingPlansRoutes
// shares /api/billing with a public GET /plans. Scope auth to the
// specific sub-paths so /plans is never accidentally gated.
//
// The mounted set is the INTERSECTION of routes the SaaS side exposes
// (see billing.routes.ts). PATCH /subscription, GET /payment-methods,
// POST /payment-methods, and GET /invoices do not exist on the SaaS
// side — invoices and payment methods are owned by Stripe's hosted
// portal (POST /portal returns the redirect URL), and subscription
// updates use POST /subscription (checkout), /cancel, or /resume. Mounting
// the orphan routes here just routed dashboard calls into 404 HTML
// pages from the SaaS proxy, breaking dashboard error handling.
r.use("/state", authMiddleware);
r.use("/subscription", authMiddleware);
r.use("/cancel", authMiddleware);
r.use("/resume", authMiddleware);
r.use("/usage", authMiddleware);
r.use("/resources", authMiddleware);
r.use("/allowances", authMiddleware);
r.use("/topup", authMiddleware);
r.use("/topup-packs", authMiddleware);
r.use("/portal", authMiddleware);

/* ---------- Dashboard state snapshot ---------- */
r.get("/state", { tag: "billing:read", authorizationHandledByOperation: true }, billingLocal.getState);

/* ---------- Subscriptions ---------- */
r.get("/subscription", { tag: "billing:read", authorizationHandledByOperation: true }, billingLocal.getSubscription);
r.post("/subscription", { body: CreateSubscriptionBody, tag: "billing:write", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" }, billingLocal.createSubscription);

/* ---------- Cancellation ---------- */
// Renewal controls use the same grants as the SaaS operations.
r.post("/cancel", { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" }, billingLocal.cancelSubscription);
r.post("/resume", { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" }, billingLocal.resumeSubscription);

/* ---------- Usage ---------- */
r.get("/usage", { tag: "billing:read", authorizationHandledByOperation: true }, billingLocal.getUsage);
r.get("/resources", { tag: "billing:read", authorizationHandledByOperation: true }, billingLocal.getResources);
r.get("/allowances", { tag: "billing:read", authorizationHandledByOperation: true }, billingLocal.listAllowanceDetail);

/* ---------- Top-ups ---------- */
r.get("/topup-packs", { tag: "billing:read", authorizationHandledByOperation: true }, billingLocal.listTopupPacks);
r.post(
  "/topup",
  { body: CreateTopupBody, tag: "billing:write", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" },
  billingLocal.createTopup,
);

/* ---------- Namespace billing portal ---------- */
// Each call mints a Stripe portal session — tight per-org limit (20/min)
// stops a runaway frontend retry loop from racking up Stripe API spend.
r.post(
  "/portal",
  { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" },
  billingLocal.createPortal,
);
