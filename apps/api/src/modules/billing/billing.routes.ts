import { Hono } from "hono";
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
 * Stripe-powered billing — SaaS only (CLOUD_MODE=true).
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
r.use("/usage", authMiddleware);
// /webhook/stripe is intentionally unauthed — Stripe signs the request;
// signature verification happens inside the handler.

/* ---------- Dashboard state snapshot ---------- */
r.get("/state", { tag: "billing:read" }, billingController.getState);

/* ---------- Raw metered usage (Oblien usageUnits proxy) ---------- */
// Powers the dashboard usage chart. Reads only — no Stripe / Oblien
// mutation, just a passthrough to namespaces.usageUnits.
r.get("/usage", { tag: "billing:read" }, billingController.getUsage);

/* ---------- Allowance detail ---------- */
// WHICH resources are consuming a quota, not just how many. The capacity meters
// give a number; this gives the list a user can act on (each free subdomain with
// the project holding it), which nothing else in the product exposes org-wide.
r.get("/allowances", { tag: "billing:read" }, billingController.listAllowanceDetail);

/* ---------- Subscription ---------- */
// GET returns the per-org subscription slice (tier + status + period).
// POST starts a Stripe Checkout session for an upgrade — the
// `customer.subscription.*` webhooks finalize the local row.
r.get("/subscription", { tag: "billing:read" }, billingController.getSubscription);
r.post("/subscription", { tag: "billing:write" }, billingController.createSubscription);

/* ---------- Cancellation ---------- */
// Destructive — admin tier per the same precedent as the domain DELETE
// flow. Flips `cancel_at_period_end=true` on Stripe; the deletion
// webhook downgrades the local row when the period ends.
r.post("/cancel", { tag: "billing:admin" }, billingController.cancelSubscription);

/* ---------- One-shot top-ups ---------- */
r.get("/topup-packs", { tag: "billing:read" }, billingController.listTopupPacks);
r.post(
  "/topup",
  { tag: "billing:write", rateLimit: "billing-portal" },
  billingController.createTopup,
);

/* ---------- Stripe Portal (invoices + PM management) ---------- */
// POST (not GET) because creating a portal session is a Stripe-side
// mutation: each call mints a new short-lived session token. Tight
// per-org rate limit caps runaway frontend retry loops that would
// otherwise rack up Stripe API spend.
r.post(
  "/portal",
  { tag: "billing:write", rateLimit: "billing-portal" },
  billingController.createPortal,
);

/* ---------- Webhook ---------- */
r.public(
  "post",
  "/webhook/stripe",
  { reason: "Stripe-signed webhook — signature verified in handler, no session auth" },
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
