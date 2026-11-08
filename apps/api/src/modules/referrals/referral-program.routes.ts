import { Hono, type Context } from "hono";
import { ReferralOperationSchemas, ReferralRoutes, type ReferralOperations } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { secureRouter } from "../../lib/secure-router";

const metadata = {
  authorizationHandledByOperation: true,
  mcpExcluded:
    "Personal referral earnings and cash payout requests are managed in the Referral page.",
};
const read = { ...metadata, tag: "billing:read" as const };
const write = {
  ...metadata,
  tag: "billing:write" as const,
  auditHandledByOperation: true,
  rateLimit: "billing-portal" as const,
};

function handler(name: keyof ReferralOperations) {
  return async (c: Context) => {
    c.header("Cache-Control", "no-store, private");
    const input: Record<string, unknown> =
      ReferralRoutes[name].method === "GET"
        ? c.req.query()
        : c.req.raw.body
          ? await c.req.json()
          : {};
    for (const key of ["limit", "offset"])
      if (typeof input[key] === "string") input[key] = Number(input[key]);
    const operation = getPlatformKernel().referralProgram[name] as (
      ctx: ReturnType<typeof operationContext>,
      input: unknown,
    ) => Promise<{ context: ReturnType<typeof operationContext>; data: unknown }>;
    return c.json({ data: await operationData(c, operation(operationContext(c), input)) });
  };
}

export const referralProgramRoutes = new Hono();
export const legacyReferralProgramRoutes = new Hono();
const r = secureRouter(referralProgramRoutes, {
  module: "referrals",
  basePath: "/api/referral-program",
});
const legacy = secureRouter(legacyReferralProgramRoutes, {
  module: "referrals",
  basePath: "/api/affiliates",
});

// One path/operation table registers both entry points with explicit security metadata.
for (const [path, name] of [
  ["/", "overview"],
  ["/offers", "offers"],
  ["/referrals", "referrals"],
  ["/referrals/payments", "payments"],
  ["/payouts", "payouts"],
] as const) {
  const spec = ReferralOperationSchemas[name];
  r.get(path, { ...read, query: "input" in spec ? spec.input : undefined }, handler(name));
  legacy.get(path, { ...read, query: "input" in spec ? spec.input : undefined }, handler(name));
}
for (const [path, name] of [
  ["/enroll", "enroll"],
  ["/offers", "createOffer"],
  ["/offers/revoke", "revokeOffer"],
  ["/payouts", "requestPayout"],
  ["/payout-destination", "setPayoutDestination"],
  ["/payouts/cancel", "cancelPayout"],
] as const) {
  const spec = ReferralOperationSchemas[name];
  r.post(path, { ...write, body: "input" in spec ? spec.input : undefined }, handler(name));
  legacy.post(path, { ...write, body: "input" in spec ? spec.input : undefined }, handler(name));
}
