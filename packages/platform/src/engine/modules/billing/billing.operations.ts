import { BillingOperationSchemas, OperationError, isRecord, normalizeBillingCreditPacks } from "@repo/contracts";
import { createPublicBillingOperations, type BillingDependencies } from "../../../billing";
import type { ExecutionContext } from "../../../context";
import type { ScopedServices } from "../../../resource-operations";
import { env } from "../../config/env";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import * as service from "./billing-application.service";
import { proxyToCloudBilling } from "./billing-local.service";

const routes = {
  getState: ["GET", "/state"], getResources: ["GET", "/resources"], getSubscription: ["GET", "/subscription"],
  createSubscription: ["POST", "/subscription"], cancelSubscription: ["POST", "/cancel"],
  resumeSubscription: ["POST", "/resume"],
  createTopup: ["POST", "/topup"], listTopupPacks: ["GET", "/topup-packs"],
  createPortal: ["POST", "/portal"], getUsage: ["GET", "/usage"], listAllowanceDetail: ["GET", "/allowances"],
} as const satisfies Record<keyof typeof BillingOperationSchemas, readonly [string, string]>;

async function invoke(name: keyof typeof BillingOperationSchemas, ctx: ExecutionContext, input: unknown) {
  let data: unknown;
  if (env.CLOUD_MODE) {
    const run = service[name] as (ctx: ExecutionContext, input: unknown) => Promise<unknown>;
    data = await run(ctx, input);
  } else {
    const [method, route] = routes[name];
    const query = new URLSearchParams();
    if (method === "GET" && isRecord(input)) for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
    const path = query.size ? `${route}?${query}` : route;
    const result = await proxyToCloudBilling(ctx, path, method, method === "POST" && input !== undefined ? JSON.stringify(input) : undefined);
    if (result.status < 200 || result.status >= 300) {
      const body = isRecord(result.payload) ? result.payload : {};
      throw new OperationError(typeof body.error === "string" ? body.error : "Cloud billing request failed", result.status,
        typeof body.code === "string" ? body.code : undefined, body);
    }
    data = isRecord(result.payload) ? result.payload.data : undefined;
    if (name === "listTopupPacks") data = normalizeBillingCreditPacks(data);
  }
  const action = BillingOperationSchemas[name].action;
  if (action !== "read") audit.recordAsync(operationAuditContext(ctx), {
    eventType: `billing:${action}`, resourceType: "billing", resourceId: ctx.organizationId,
    // Checkout and portal URLs contain session credentials: never audit the result.
    after: { operation: name, ...(isRecord(input) ? input : {}) },
  });
  return data;
}

export const billingDependencies: BillingDependencies = {
  public: { listPlans: service.listPlans },
  collection: Object.fromEntries(Object.keys(BillingOperationSchemas).map(name => [name,
    (ctx: ExecutionContext, input: unknown) => invoke(name as keyof typeof BillingOperationSchemas, ctx, input),
  ])) as ScopedServices<typeof BillingOperationSchemas>,
};
export const publicBillingOperations = createPublicBillingOperations(billingDependencies.public);
