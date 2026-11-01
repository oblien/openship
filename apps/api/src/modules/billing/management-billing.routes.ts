import { Hono } from "hono";
import { BillingOperationSchemas } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { authMiddleware } from "../../middleware";
import { operationContext, operationData } from "../../lib/operation-context";
import { secureRouter } from "../../lib/secure-router";

export const managementBillingRoutes = new Hono();
const r = secureRouter(managementBillingRoutes, { module: "billing", basePath: "/api/billing" });
r.use("/manage", authMiddleware);
r.use("/manage/*", authMiddleware);
r.get(
  "/manage",
  {
    tag: "billing:read",
    authorizationHandledByOperation: true,
    mcp: {
      description:
        "Read hosted management pricing, verified subscription and connected-server allowance for this organization.",
    },
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(c, getPlatformKernel().billing.getManagement(operationContext(c))),
    });
  },
);
r.post(
  "/manage/checkout",
  {
    tag: "billing:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded: "Paid management subscriptions are authorized in Billing → Your infrastructure.",
    body: BillingOperationSchemas.purchaseManagement.input,
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.purchaseManagement(operationContext(c), await c.req.json()),
      ),
    });
  },
);
r.post(
  "/manage/change",
  {
    tag: "billing:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded: "Paid management subscriptions are authorized in Billing → Your infrastructure.",
    body: BillingOperationSchemas.confirmManagementChange.input,
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.confirmManagementChange(
          operationContext(c),
          await c.req.json(),
        ),
      ),
    });
  },
);
r.post(
  "/manage/checkout/cancel",
  {
    tag: "billing:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded: "Paid management subscriptions are authorized in Billing → Your infrastructure.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.cancelManagementCheckout(operationContext(c)),
      ),
    });
  },
);
r.post(
  "/manage/cancel",
  {
    tag: "billing:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded: "Paid management subscriptions are authorized in Billing → Your infrastructure.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.cancelManagementSubscription(operationContext(c)),
      ),
    });
  },
);
r.post(
  "/manage/resume",
  {
    tag: "billing:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded: "Paid management subscriptions are authorized in Billing → Your infrastructure.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.resumeManagementSubscription(operationContext(c)),
      ),
    });
  },
);
r.post(
  "/manage/portal",
  {
    tag: "billing:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded: "Paid management subscriptions are authorized in Billing → Your infrastructure.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.createManagementPortal(operationContext(c)),
      ),
    });
  },
);

r.post(
  "/manage/checkout/resume",
  {
    tag: "billing:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded: "Management billing changes require user confirmation.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.resumeManagementCheckout(operationContext(c)),
      ),
    });
  },
);

r.post(
  "/manage/change/cancel",
  {
    tag: "billing:admin",
    authorizationHandledByOperation: true,
    auditHandledByOperation: true,
    rateLimit: "billing-portal",
    mcpExcluded: "Management billing changes require user confirmation.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await operationData(
        c,
        getPlatformKernel().billing.cancelManagementChange(operationContext(c)),
      ),
    });
  },
);
