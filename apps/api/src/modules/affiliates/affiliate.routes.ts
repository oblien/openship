import { Hono, type Context } from "hono";
import {
  AffiliateOperationSchemas,
  AffiliateRoutes,
  type AffiliateOperations,
} from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { secureRouter } from "../../lib/secure-router";

export const affiliateRoutes = new Hono();
const r = secureRouter(affiliateRoutes, { module: "affiliates", basePath: "/api/affiliates" });
const metadata = {
  authorizationHandledByOperation: true,
  mcpExcluded:
    "Personal affiliate earnings and cash payout requests are managed in the Affiliates page.",
};
const read = { ...metadata, tag: "billing:read" as const };
const write = {
  ...metadata,
  tag: "billing:write" as const,
  auditHandledByOperation: true,
  rateLimit: "billing-portal" as const,
};

function handler(name: keyof AffiliateOperations) {
  return async (c: Context) => {
    c.header("Cache-Control", "no-store, private");
    const input: Record<string, unknown> =
      AffiliateRoutes[name].method === "GET"
        ? c.req.query()
        : c.req.raw.body
          ? await c.req.json()
          : {};
    for (const key of ["limit", "offset"])
      if (typeof input[key] === "string") input[key] = Number(input[key]);
    const operation = getPlatformKernel().affiliates[name] as (
      ctx: ReturnType<typeof operationContext>,
      input: unknown,
    ) => Promise<{ context: ReturnType<typeof operationContext>; data: unknown }>;
    return c.json({ data: await operationData(c, operation(operationContext(c), input)) });
  };
}

// Static declarations keep permission/documentation scanning compatible. The
// route test checks these paths against the shared SDK/dashboard route contract.
for (const [path, name] of [
  ["/", "overview"],
  ["/offers", "offers"],
  ["/referrals", "referrals"],
  ["/referrals/payments", "payments"],
  ["/payouts", "payouts"],
] as const) {
  const spec = AffiliateOperationSchemas[name];
  r.get(path, { ...read, query: "input" in spec ? spec.input : undefined }, handler(name));
}
for (const [path, name] of [
  ["/enroll", "enroll"],
  ["/offers", "createOffer"],
  ["/offers/revoke", "revokeOffer"],
  ["/payouts", "requestPayout"],
  ["/payout-destination", "setPayoutDestination"],
  ["/payouts/cancel", "cancelPayout"],
] as const) {
  const spec = AffiliateOperationSchemas[name];
  r.post(path, { ...write, body: "input" in spec ? spec.input : undefined }, handler(name));
}
