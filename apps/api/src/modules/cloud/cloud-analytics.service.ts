/**
 * Cloud analytics service — proxies Oblien analytics calls.
 *
 * Auth model: **namespace token is the authorization**.
 *
 *   1. Mint a namespace-scoped Oblien token for the caller's org.
 *   2. Pass it straight to Oblien's analytics endpoints.
 *   3. Oblien enforces namespace ownership server-side — a request for
 *      a domain outside the caller's namespace gets rejected at Oblien,
 *      not by us.
 *
 * The namespace IS the security boundary; Oblien IS the source of truth
 * for "which namespace owns which hostname." No SaaS-side ownership
 * ledger. No two-step verify. No cache. One call, one credential.
 *
 * ─── Required Oblien behavior (track upstream) ──────────────────────────
 *
 *   This service depends on Oblien correctly gating analytics endpoints
 *   by namespace when called with a namespace token. If any of the
 *   following are broken in the Oblien backend, the symptoms surface
 *   here as silent empty 200s, 403 admin-required, or wrong-tenant data
 *   leakage. Fix them upstream rather than working around here:
 *
 *   1. `analytics.timeseries(domain)` with namespace token MUST:
 *      - return the timeseries when the domain belongs to the namespace
 *      - return 403/404 when the domain belongs to a different namespace
 *      - NOT return an empty 200 (silently zero-out data) for either case
 *
 *   2. `analytics.requests(domain)`, `analytics.streamToken(domain)`,
 *      `analytics.geo(domain)`, `analytics.get(domain)` — same contract
 *      as (1).
 *
 *   3. The namespace ownership check must run BEFORE any access-scope
 *      check. Right now namespace tokens get rejected with
 *      "scope: namespace, required: admin" on some endpoints
 *      (`pages.delete/disable/enable`, `edgeProxy.list`) — that's
 *      backwards. Namespace tokens should be allowed on namespace-scoped
 *      resources; admin scope should only be required for cross-
 *      namespace ops or namespace lifecycle (create/delete the
 *      namespace itself, set quotas, etc.).
 */

import { Oblien } from "@repo/adapters";
import { issueNamespaceToken } from "../../lib/openship-cloud";

export type CloudAnalyticsOperation = "timeseries" | "requests" | "streamToken";

export class CloudAnalyticsForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(domain: string) {
    super(`You do not own analytics for ${domain}`);
    this.name = "CloudAnalyticsForbiddenError";
  }
}

/**
 * Map an Oblien error to our forbidden type when it looks like a
 * cross-tenant / not-found rejection — so the caller gets a friendly
 * 403 instead of a generic 500.
 */
function isCrossTenantError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number }).status;
  if (status === 403 || status === 404) return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("does not have access") ||
    msg.includes("does not belong")
  );
}

/**
 * Per-operation allowlist for analytics params.
 *
 * The Oblien SDK ignores unknown keys today, but the `as any` cast that
 * previously sat at the call site let arbitrary caller-supplied fields
 * flow straight through. If Oblien ever adds a sensitive override key
 * (e.g. `namespace`), that pattern grows teeth. Filter at the service
 * boundary so the SDK can only see keys it legitimately accepts.
 *
 * Shapes mirror the SDK's `AnalyticsTimeseriesParams` /
 * `AnalyticsRequestsParams` interfaces in `oblien/dist/types/analytics.d.ts`.
 */
function pickAnalyticsParams(
  op: CloudAnalyticsOperation,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const picked: Record<string, unknown> = {};
  switch (op) {
    case "timeseries":
      if (params.from !== undefined) picked.from = params.from;
      if (params.to !== undefined) picked.to = params.to;
      if (params.interval !== undefined) picked.interval = params.interval;
      break;
    case "requests":
      if (params.limit !== undefined) picked.limit = params.limit;
      break;
    case "streamToken":
      // SDK signature takes no params; allowlist is empty by design.
      break;
  }
  return picked;
}

export async function proxyCloudAnalytics(
  organizationId: string,
  input: {
    operation: CloudAnalyticsOperation;
    domain: string;
    params?: Record<string, unknown>;
  },
): Promise<unknown> {
  const { token } = await issueNamespaceToken(organizationId);
  const client = new Oblien({ token });

  try {
    switch (input.operation) {
      case "timeseries":
        return await client.analytics.timeseries(
          input.domain,
          pickAnalyticsParams("timeseries", input.params),
        );
      case "requests":
        return await client.analytics.requests(
          input.domain,
          pickAnalyticsParams("requests", input.params),
        );
      case "streamToken":
        return await client.analytics.streamToken(input.domain);
    }
  } catch (err) {
    if (isCrossTenantError(err)) {
      throw new CloudAnalyticsForbiddenError(input.domain);
    }
    throw err;
  }
}
