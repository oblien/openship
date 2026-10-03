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
import { BillingOperationSchemas, CreateSubscriptionBody, CreateTopupBody } from "@repo/contracts";
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
r.use("/credit-alerts", authMiddleware);
r.use("/checkout", authMiddleware);
r.use("/subscription", authMiddleware);
r.use("/subscription/quote", authMiddleware);
r.use("/cancel", authMiddleware);
r.use("/resume", authMiddleware);
r.use("/usage", authMiddleware);
r.use("/resources", authMiddleware);
r.use("/capacity", authMiddleware);
r.use("/capacity/*", authMiddleware);
r.use("/allowances", authMiddleware);
r.use("/topup", authMiddleware);
r.use("/topup-packs", authMiddleware);
r.use("/portal", authMiddleware);

/* ---------- Dashboard state snapshot ---------- */
r.get("/credit-alerts", { tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Read provider credit alerts across this organization's managed servers. Each result identifies its subscription; unavailable balances remain unknown." } }, billingLocal.getCreditAlerts);
r.get("/state", { query: BillingOperationSchemas.getState.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Read the workspace’s Cloud billing state, current plan, balance and limits. Self-hosted instances need a connected Cloud account for this data." } }, billingLocal.getState);
r.get(
  "/checkout",
  { tag: "billing:read", authorizationHandledByOperation: true, mcpExcluded: "Browser checkout configuration; use the billing reads to inspect a plan and complete purchases in Settings → Billing." },
  billingLocal.getCheckout,
);

/* ---------- Subscriptions ---------- */
r.get("/subscription/quote", { query: BillingOperationSchemas.quoteCustomPlan.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Quote a Custom Cloud server's monthly retail price and included usage allowance from CPU, memory in MB, and disk in GB. This read does not create a server or start a purchase. Complete checkout in Billing." } }, billingLocal.quoteCustomPlan);
r.get("/subscription", { query: BillingOperationSchemas.getSubscription.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Read the workspace’s current subscription tier, state and billing period." } }, billingLocal.getSubscription);
r.post("/subscription", { body: CreateSubscriptionBody, tag: "billing:write", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Starts a paid browser checkout. Purchases and payment authorization are completed in Settings → Billing." }, billingLocal.createSubscription);

/* ---------- Cancellation ---------- */
// Renewal controls use the same grants as the SaaS operations.
r.post("/cancel", { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Paid subscription renewal is managed by the account owner in Settings → Billing; MCP exposes the resulting subscription state." }, billingLocal.cancelSubscription);
r.post("/resume", { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Paid subscription renewal is managed by the account owner in Settings → Billing; MCP exposes the resulting subscription state." }, billingLocal.resumeSubscription);

/* ---------- Usage ---------- */
r.get("/usage", { tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Read metered Cloud usage over the requested date range, grouped by hour or day. This is billing data, not live workload metrics." }, query: BillingOperationSchemas.getUsage.input }, billingLocal.getUsage);
r.get("/resources", { query: BillingOperationSchemas.getResources.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "List Cloud resources contributing to this workspace’s bill and usage." } }, billingLocal.getResources);
r.get("/allowances", { query: BillingOperationSchemas.listAllowanceDetail.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "List resources consuming workspace allowances, including the projects holding managed domains." } }, billingLocal.listAllowanceDetail);


/* ---------- Top-ups ---------- */
r.get("/topup-packs", { tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "List available Cloud credit packs and prices. Reading this does not buy credits." } }, billingLocal.listTopupPacks);
r.post(
  "/topup",
  { body: CreateTopupBody, tag: "billing:write", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Starts a paid browser checkout. Buy credits in Settings → Billing; MCP can list pack prices and current balance." },
  billingLocal.createTopup,
);

/* ---------- Namespace billing portal ---------- */
// Each call mints a Stripe portal session — tight per-org limit (20/min)
// stops a runaway frontend retry loop from racking up Stripe API spend.
r.post(
  "/portal",
  { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Creates an account billing-portal session. Open Settings → Billing to manage payment details." },
  billingLocal.createPortal,
);
