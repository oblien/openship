import { Hono } from "hono";
import { CreateSubscriptionBody, CreateTopupBody } from "@repo/contracts";
import { authMiddleware } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as billingController from "./billing.controller";
import { oblienWebhook } from "./oblien-webhook.controller";

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
export const billingSaasRoutes = new Hono();
const r = secureRouter(billingSaasRoutes, {
  module: "billing",
  basePath: "/api/billing",
});

r.use("/state", authMiddleware);
r.use("/subscription", authMiddleware);
r.use("/topup", authMiddleware);
r.use("/topup-packs", authMiddleware);
r.use("/portal", authMiddleware);
r.use("/cancel", authMiddleware);
r.use("/resume", authMiddleware);
r.use("/usage", authMiddleware);
r.use("/resources", authMiddleware);
r.use("/allowances", authMiddleware);
// The retired Stripe webhook always returns 410 and performs no mutation.

/* ---------- Dashboard state snapshot ---------- */
r.get("/state", { tag: "billing:read", authorizationHandledByOperation: true }, billingController.getState);

/* ---------- Raw metered usage (Oblien usageUnits proxy) ---------- */
// Powers the dashboard usage chart. Reads only — no Stripe / Oblien
// mutation, just a passthrough to namespaces.usageUnits.
r.get("/usage", { tag: "billing:read", authorizationHandledByOperation: true }, billingController.getUsage);
r.get("/resources", { tag: "billing:read", authorizationHandledByOperation: true }, billingController.getResources);

/* ---------- Allowance detail ---------- */
// WHICH resources are consuming a quota, not just how many. The capacity meters
// give a number; this gives the list a user can act on (each free subdomain with
// the project holding it), which nothing else in the product exposes org-wide.
r.get("/allowances", { tag: "billing:read", authorizationHandledByOperation: true }, billingController.listAllowanceDetail);

/* ---------- Subscription ---------- */
// GET returns the per-org subscription slice (tier + status + period).
// POST requests an Oblien hosted checkout; provider entitlements confirm access.
r.get("/subscription", { tag: "billing:read", authorizationHandledByOperation: true }, billingController.getSubscription);
r.post("/subscription", { body: CreateSubscriptionBody, tag: "billing:write", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" }, billingController.createSubscription);

/* ---------- Cancellation ---------- */
// Oblien keeps paid access until period end; both renewal actions are repeatable.
r.post("/cancel", { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" }, billingController.cancelSubscription);
r.post("/resume", { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" }, billingController.resumeSubscription);

/* ---------- One-shot top-ups ---------- */
r.get("/topup-packs", { tag: "billing:read", authorizationHandledByOperation: true }, billingController.listTopupPacks);
r.post(
  "/topup",
  { body: CreateTopupBody, tag: "billing:write", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" },
  billingController.createTopup,
);

/* ---------- Billing management ---------- */
// The portal can cancel renewal, so it requires billing:admin too.
r.post(
  "/portal",
  { tag: "billing:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal" },
  billingController.createPortal,
);

/* ---------- Webhook ---------- */
r.public(
  "post",
  "/webhook/stripe",
  { reason: "Retired Stripe endpoint — always 410, no billing mutations" },
  billingController.stripeWebhook,
);

/* ---------- Oblien webhook (credits.depleted, credits.low, threshold) ---------- */
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
