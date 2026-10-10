import { Hono } from "hono";
import { BillingOperationSchemas, CreateSubscriptionBody, CreateTopupBody } from "@repo/contracts";
import { authMiddleware } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as billingController from "./billing.controller";
import { oblienWebhook } from "./oblien-webhook.controller";
import { billingPlanChangeRoutes } from "./billing-plan-change.routes";
import { billingCheckoutRoutes } from "./billing-checkout.routes";
import { actionsBillingRoutes } from "./actions-billing.routes";

/**
 * Plan info — no Stripe required, works on ALL instances.
 * Registered at `/api/billing` on every deploy mode.
 *
 * The /plans route is intentionally PUBLIC: the marketing site and the
 * pre-signup pricing page need it before the user has a session.
 */
export const billingPlansRoutes = new Hono();
const plansR = secureRouter(billingPlansRoutes, {
  module: "billing-plans",
  basePath: "/api/billing",
});
plansR.public(
  "get",
  "/plans",
  { reason: "Public pricing endpoint — read by marketing site + signup flow before auth" },
  billingController.listPlans,
);

/**
 * Oblien-managed billing — SaaS only (CLOUD_MODE=true).
 * Registered at `/api/billing` only when CLOUD_MODE.
 *
 * ⚠ This sub-app shares the `/api/billing` mount prefix with
 * `billingPlansRoutes` (which serves a PUBLIC GET /plans). Using
 * `.use("*", authMiddleware)` here would extend across siblings in
 * Hono v4 — same landmine the backup-routes had. Scope auth to the
 * specific sub-paths via per-path .use(), letting /plans stay reachable
 * regardless of mount order. The secureRouter permission middleware
 * runs AFTER authMiddleware on every route, layered automatically.
 */
export const billingSaasRoutes = new Hono().route("/", billingPlanChangeRoutes).route("/", billingCheckoutRoutes).route("/", actionsBillingRoutes);
const r = secureRouter(billingSaasRoutes, {
  module: "billing",
  basePath: "/api/billing",
});

r.use("/state", authMiddleware);
r.use("/credit-alerts", authMiddleware);
r.use("/checkout", authMiddleware);
r.use("/subscription", authMiddleware);
r.use("/subscription/quote", authMiddleware);
r.use("/topup", authMiddleware);
r.use("/topup-packs", authMiddleware);
r.use("/portal", authMiddleware);
r.use("/cancel", authMiddleware);
r.use("/resume", authMiddleware);
r.use("/usage", authMiddleware);
r.use("/resources", authMiddleware);
r.use("/capacity", authMiddleware);
r.use("/capacity/*", authMiddleware);
r.use("/allowances", authMiddleware);
// The retired Stripe webhook always returns 410 and performs no mutation.

/* ---------- Dashboard state snapshot ---------- */
r.get("/credit-alerts", { tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Read monthly compute coverage and metered credit alerts across this organization's managed servers. Each result identifies its server; unavailable billing state remains unknown." } }, billingController.getCreditAlerts);
r.get("/state", { query: BillingOperationSchemas.getState.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Read the selected Cloud server's saved plan, paid compute coverage, usage and resource limits. Older metered plans also include their credit balance. Self-hosted instances need a connected Cloud account." } }, billingController.getState);
r.get(
  "/checkout",
  { tag: "billing:read", authorizationHandledByOperation: true, mcpExcluded: "Browser checkout configuration; use the billing reads to inspect a plan and complete purchases in Settings → Billing." },
  billingController.getCheckout,
);

/* ---------- Raw metered usage (Oblien usageUnits proxy) ---------- */
// Powers the dashboard usage chart. Reads only — no Stripe / Oblien
// mutation, just a passthrough to namespaces.usageUnits.
r.get("/usage", { tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Read metered Cloud usage over the requested date range, grouped by hour or day. This is billing data, not live workload metrics." }, query: BillingOperationSchemas.getUsage.input }, billingController.getUsage);
r.get("/resources", { query: BillingOperationSchemas.getResources.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "List Cloud resources contributing to this workspace’s bill and usage." } }, billingController.getResources);

/* ---------- Allowance detail ---------- */
// WHICH resources are consuming a quota, not just how many. The capacity meters
// give a number; this gives the list a user can act on (each free subdomain with
// the project holding it), which nothing else in the product exposes org-wide.
r.get("/allowances", { query: BillingOperationSchemas.listAllowanceDetail.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "List resources consuming workspace allowances, including the projects holding managed domains." } }, billingController.listAllowanceDetail);

/* ---------- Subscription ---------- */
r.get("/subscription/quote", { query: BillingOperationSchemas.quoteCustomPlan.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Quote a Custom Cloud server's monthly retail price for its CPU, memory in MiB, and disk in GiB. Monthly compute and storage are covered for the paid period, without a compute-credit allowance. This read does not create a server or start a purchase. Complete checkout in Billing." } }, billingController.quoteCustomPlan);
// GET returns the per-org subscription slice (tier + status + period).
// POST requests an Oblien hosted checkout; provider entitlements confirm access.
r.get("/subscription", { query: BillingOperationSchemas.getSubscription.input, tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "Read the selected Cloud server's saved subscription, billing mode, paid period and pending plan change." } }, billingController.getSubscription);
r.post("/subscription", { body: CreateSubscriptionBody, tag: "billing:write", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Starts a paid browser checkout. Purchases and payment authorization are completed in Settings → Billing." }, billingController.createSubscription);

/* ---------- Cancellation ---------- */
// Oblien keeps paid access until period end; both renewal actions are repeatable.
r.post("/cancel", { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Paid subscription renewal is managed by the account owner in Settings → Billing; MCP exposes the resulting subscription state." }, billingController.cancelSubscription);
r.post("/resume", { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Paid subscription renewal is managed by the account owner in Settings → Billing; MCP exposes the resulting subscription state." }, billingController.resumeSubscription);

/* ---------- One-shot top-ups ---------- */
r.get("/topup-packs", { tag: "billing:read", authorizationHandledByOperation: true, mcp: { description: "List metered Cloud credit packs and prices. Monthly servers need no compute-credit top-ups. Reading this does not buy credits." } }, billingController.listTopupPacks);
r.post(
  "/topup",
  { body: CreateTopupBody, tag: "billing:write", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Starts a paid browser checkout. Buy credits in Settings → Billing; MCP can list pack prices and current balance." },
  billingController.createTopup,
);

/* ---------- Billing management ---------- */
// The portal can cancel renewal, so it requires billing:admin too.
r.post(
  "/portal",
  { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal", mcpExcluded: "Creates an account billing-portal session. Open Settings → Billing to manage payment details." },
  billingController.createPortal,
);

/* ---------- Webhook ---------- */
r.public(
  "post",
  "/webhook/stripe",
  { reason: "Retired Stripe endpoint — always 410, no billing mutations" },
  billingController.stripeWebhook,
);

/* ---------- Signed Oblien billing events ---------- */
// Mounted SaaS-only — Oblien posts to the cloud control plane, never
// to self-hosted instances. Auth is the HMAC signature in
// X-Webhook-Signature, verified inside the handler against
// OBLIEN_WEBHOOK_SECRET.
r.public(
  "post",
  "/oblien-webhook",
  { reason: "Oblien webhook — verified via X-Webhook-Signature, not user session" },
  oblienWebhook,
);
