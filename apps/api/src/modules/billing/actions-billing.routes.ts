import { Hono } from "hono";
import { BillingOperationSchemas } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { authMiddleware } from "../../middleware";
import { operationContext, operationData } from "../../lib/operation-context";
import { secureRouter } from "../../lib/secure-router";

/** One authenticated surface for Cloud and the linked-instance billing proxy. */
export const actionsBillingRoutes = new Hono();
const r = secureRouter(actionsBillingRoutes, { module: "billing", basePath: "/api/billing" });
r.use("/actions", authMiddleware);
r.use("/actions/*", authMiddleware);
r.get(
  "/actions",
  {
    tag: "billing:read",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Read the organization's separate prepaid Cloud Actions balance, live VM usage rates, estimated minutes and recent deposits. Amounts use the returned unitsPerDollar. Does not create a checkout or expose payment URLs. Purchases may be unavailable.",
    },
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.getActionsBudget(operationContext(c)),
      ),
    });
  },
);
r.get(
  "/actions/purchase",
  {
    tag: "billing:read",
    authorizationHandledByOperation: true,
    query: BillingOperationSchemas.getActionsPurchase.input,
    rateLimit: "billing-portal",
    mcpExcluded:
      "Reconciles a browser payment with its verified provider receipt. Use Actions → Budget for payment recovery.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.getActionsPurchase(operationContext(c), {
          purchaseId: c.req.query("purchaseId") ?? "",
        }),
      ),
    });
  },
);
r.post(
  "/actions/checkout",
  {
    tag: "billing:write",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: BillingOperationSchemas.createActionsCheckout.input,
    rateLimit: "billing-portal",
    mcpExcluded:
      "Starts a prepaid browser payment. Complete payment in Actions → Budget when purchases are available.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.createActionsCheckout(operationContext(c), await c.req.json()),
      ),
    });
  },
);
r.post(
  "/actions/checkout/resume",
  {
    tag: "billing:write",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    body: BillingOperationSchemas.resumeActionsCheckout.input,
    rateLimit: "billing-portal",
    mcpExcluded:
      "Resumes the original prepaid browser checkout. Complete payment in Actions → Budget.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.resumeActionsCheckout(operationContext(c), await c.req.json()),
      ),
    });
  },
);
