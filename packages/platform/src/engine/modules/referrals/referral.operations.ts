import {
  ReferralOperationSchemas,
  ReferralRoutes,
  AppError,
  OperationError,
  isRecord,
  type ReferralOperations,
} from "@repo/contracts";
import type { ReferralDependencies } from "../../../referrals";
import type { ExecutionContext } from "../../../context";
import { env, runtimeTarget } from "../../config/env";
import { getOblienBillingApi } from "../../lib/oblien-client";
import { cloudFetch } from "../../lib/cloud/transport";
import { assertCloudProxyScope } from "../../lib/cloud/scope";
import {
  callReferralProvider,
  referralParticipantKey,
  unavailableReferralOverview,
} from "./referral-provider";

async function invoke(
  operation: keyof ReferralOperations,
  ctx: ExecutionContext,
  raw: unknown = {},
) {
  const input = isRecord(raw) ? raw : {};
  if (!env.CLOUD_MODE) {
    assertCloudProxyScope(ctx);
    const route = ReferralRoutes[operation];
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
        "Connect your OpenShip Cloud account to manage referrals",
        403,
        "CLOUD_NOT_CONNECTED",
      );
    const body = await response.json();
    if (!response.ok)
      throw new OperationError(
        isRecord(body) && typeof body.error === "string" ? body.error : "Referral request failed",
        response.status,
        isRecord(body) && typeof body.code === "string" ? body.code : undefined,
      );
    if (!isRecord(body)) throw new OperationError("Invalid referral response", 502);
    return body.data;
  }
  if (!env.REFERRALS_ENABLED) {
    if (operation === "overview") return unavailableReferralOverview();
    throw new AppError("The referral program is not available yet", 503, "AFFILIATES_UNAVAILABLE");
  }
  return callReferralProvider(
    getOblienBillingApi(),
    {
      namespace: env.REFERRAL_NAMESPACE,
      participantKey: referralParticipantKey(ctx.userId),
    },
    runtimeTarget.dashboard,
    operation,
    input,
  );
}

export const referralDependencies: ReferralDependencies = {
  collection: Object.fromEntries(
    Object.keys(ReferralOperationSchemas).map((name) => [
      name,
      (ctx: ExecutionContext, input?: unknown) =>
        invoke(name as keyof ReferralOperations, ctx, input),
    ]),
  ) as ReferralDependencies["collection"],
};
