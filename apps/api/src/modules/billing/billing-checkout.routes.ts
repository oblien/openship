import { Hono } from "hono";
import { BillingOperationSchemas } from "@repo/contracts";
import { authMiddleware } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as controller from "./billing.controller";

/** Payment recovery uses the same operations in Cloud and connected installations. */
export const billingCheckoutRoutes = new Hono();
const r = secureRouter(billingCheckoutRoutes, { module: "billing", basePath: "/api/billing" });
r.use("/checkouts", authMiddleware);
r.use("/checkout/resume", authMiddleware);
r.use("/checkout/cancel", authMiddleware);
r.get(
  "/checkouts",
  {
    tag: "billing:read",
    query: BillingOperationSchemas.listCheckouts.input,
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "List unfinished payments for the organization's managed servers, optionally scoped to one server. Saved offers and verified payment state only; no checkout is created or resumed and no payment URL is exposed. Recover payments in Billing.",
    },
  },
  controller.listCheckouts,
);
r.post(
  "/checkout/resume",
  {
    tag: "billing:write",
    body: BillingOperationSchemas.resumeCheckout.input,
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded:
      "Resumes a paid browser checkout using its original offer and identity. Complete payment in Billing.",
  },
  controller.resumeCheckout,
);
r.post(
  "/checkout/cancel",
  {
    tag: "billing:admin",
    body: BillingOperationSchemas.cancelCheckout.input,
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded:
      "Cancels an unfinished hosted payment and releases its capacity reservation. Financial actions are completed in Billing.",
  },
  controller.cancelCheckout,
);
