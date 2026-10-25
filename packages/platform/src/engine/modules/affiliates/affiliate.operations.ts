import {
  AffiliateOperationSchemas,
  AffiliateRoutes,
  AppError,
  OperationError,
  isRecord,
  type AffiliateOperations,
} from "@repo/contracts";
import type { AffiliateDependencies } from "../../../affiliates";
import type { ExecutionContext } from "../../../context";
import { env, runtimeTarget } from "../../config/env";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { cloudFetch } from "../../lib/cloud/transport";
import { assertCloudProxyScope } from "../../lib/cloud/scope";
import {
  callAffiliateProvider,
  affiliateParticipantKey,
  unavailableAffiliateOverview,
} from "./affiliate-provider";

async function invoke(
  operation: keyof AffiliateOperations,
  ctx: ExecutionContext,
  raw: unknown = {},
) {
  const input = isRecord(raw) ? raw : {};
  if (!env.CLOUD_MODE) {
    assertCloudProxyScope(ctx);
    const route = AffiliateRoutes[operation];
    const query =
      route.method === "GET"
        ? new URLSearchParams(
            Object.entries(input)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]): [string, string] => [key, String(value)]),
          )
        : null;
    const response = await cloudFetch(
      ctx.userId,
      `/api${route.path}${query?.size ? `?${query}` : ""}`,
      {
        method: route.method,
        ...(route.method === "POST" ? { body: JSON.stringify(input) } : {}),
      },
    );
    if (!response)
      throw new AppError(
        "Connect your OpenShip Cloud account to manage affiliates",
        403,
        "CLOUD_NOT_CONNECTED",
      );
    const body = await response.json();
    if (!response.ok)
      throw new OperationError(
        isRecord(body) && typeof body.error === "string" ? body.error : "Affiliate request failed",
        response.status,
        isRecord(body) && typeof body.code === "string" ? body.code : undefined,
      );
    if (!isRecord(body)) throw new OperationError("Invalid affiliate response", 502);
    return body.data;
  }
  if (!env.AFFILIATES_ENABLED) {
    if (operation === "overview") return unavailableAffiliateOverview();
    throw new AppError("The affiliate program is not available yet", 503, "AFFILIATES_UNAVAILABLE");
  }
  return callAffiliateProvider(
    getOblienBillingApi(),
    {
      namespace: env.OBLIEN_AFFILIATE_NAMESPACE,
      participantKey: affiliateParticipantKey(ctx.userId),
    },
    runtimeTarget.dashboard,
    operation,
    input,
  );
}

export const affiliateDependencies: AffiliateDependencies = {
  collection: Object.fromEntries(
    Object.keys(AffiliateOperationSchemas).map((name) => [
      name,
      (ctx: ExecutionContext, input?: unknown) =>
        invoke(name as keyof AffiliateOperations, ctx, input),
    ]),
  ) as AffiliateDependencies["collection"],
};
