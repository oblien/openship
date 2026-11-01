import { Hono } from "hono";
import { BillingOperationSchemas } from "@repo/contracts";
import { authMiddleware } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as controller from "./billing.controller";

/** Mount this router in both Cloud and connected installations. */
export const billingPlanChangeRoutes = new Hono();
const r = secureRouter(billingPlanChangeRoutes, { module: "billing", basePath: "/api/billing" });
r.use("/subscription/change", authMiddleware);
r.use("/subscription/change/*", authMiddleware);
r.post("/subscription/change/preview", {
  tag: "billing:write", body: BillingOperationSchemas.previewSubscriptionChange.input,
  authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal",
  mcp: { description: "Preview an existing managed server's plan change using the provider's prorated price and next renewal date. Saves an expiring quote without charging. Uses trusted preset or Custom resources, preserves the billing interval, and lists projects that would restart. Complete confirmation in Billing." },
}, controller.previewSubscriptionChange);
r.post("/subscription/change", {
  tag: "billing:admin", body: BillingOperationSchemas.confirmSubscriptionChange.input,
  authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal",
  mcpExcluded: "Confirms a paid subscription change and server restart. Payment authorization and restart consent are completed in Billing.",
}, controller.confirmSubscriptionChange);
r.get("/subscription/change", {
  tag: "billing:read", query: BillingOperationSchemas.getSubscriptionChange.input,
  authorizationHandledByOperation: true,
  mcp: { description: "Read a provider-confirmed subscription change for the selected managed server. Queued, payment_pending and scheduled do not activate new capacity; applied confirms the new terms. Server resizing uses its existing operation status." },
}, controller.getSubscriptionChange);
r.post("/subscription/change/cancel", {
  tag: "billing:admin", body: BillingOperationSchemas.cancelSubscriptionChange.input,
  authorizationHandledByOperation: true, auditHandledByOperation: true, rateLimit: "billing-portal",
  mcpExcluded: "Cancel a pending financial change in Billing; MCP exposes its resulting status.",
}, controller.cancelSubscriptionChange);
