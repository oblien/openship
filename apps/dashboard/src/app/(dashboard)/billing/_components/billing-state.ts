import "server-only";
import { cache } from "react";
import { CLOUD_CAPABILITIES } from "@repo/core";
import { serverApi, ServerApiError } from "@/lib/server/api";
import { getDeploymentInfo } from "@/lib/server/session";
import type { BillingState } from "@/lib/api/billing";
import type { ServerDetail } from "@repo/contracts";
import type { BillingUnavailableReason } from "./BillingUnavailable";

interface BillingStateResponse {
  data: BillingState;
}

/** Billing reads remain available even when new purchases are disabled. */
type BillingFetchResult =
  | { kind: "ok"; state: BillingState }
  | { kind: "unavailable"; reason: BillingUnavailableReason };

interface CloudStatus {
  connected: boolean;
}

function logBillingFailure(status: number | null, code: string): void {
  // Diagnose SSR failures in dashboard logs without exposing provider bodies,
  // session cookies, or customer billing data.
  console.warn("[billing] GET /billing/state failed", { status, code });
}

async function fetchCloudConnected(): Promise<boolean> {
  try {
    const res = await serverApi.get<CloudStatus>("cloud/status", {
      cache: "no-store",
    });
    return res?.connected ?? false;
  } catch {
    return false;
  }
}

async function fetchBillingState(workspaceId?: string): Promise<BillingFetchResult> {
  const info = await getDeploymentInfo();
  const isLocalMode = info.selfHosted;

  try {
    const res = await serverApi.get<BillingStateResponse>(workspaceId ? `billing/state?workspaceId=${encodeURIComponent(workspaceId)}` : "billing/state", {
      cache: "no-store",
      // Namespace onboarding may perform several provider reads. Let the API
      // finish its bounded upstream requests before the dashboard gives up.
      timeout: 45_000,
    });
    if (res?.data) {
      return { kind: "ok", state: res.data };
    }
    logBillingFailure(200, "BILLING_INVALID_RESPONSE");
    return {
      kind: "unavailable",
      reason: isLocalMode ? "cloud-unreachable" : "billing-unreachable",
    };
  } catch (err) {
    if (err instanceof ServerApiError) {
      const body = err.body as { code?: unknown } | null | undefined;
      const code = typeof body?.code === "string" && /^[a-z0-9_-]{1,80}$/i.test(body.code)
        ? body.code : "BILLING_API_ERROR";
      logBillingFailure(err.status, code);
      if (code === "CLOUD_WORKSPACE_REQUIRED") return { kind: "unavailable", reason: "workspace-required" };

      if (err.status === 401) {
        return {
          kind: "unavailable",
          reason: isLocalMode && code === "cloud_session_expired"
            ? "cloud-session-expired" : "billing-sign-in-required",
        };
      }

      if (err.status === 403) {
        if (isLocalMode && code === CLOUD_CAPABILITIES.billing.code) {
          return { kind: "unavailable", reason: "cloud-not-connected" };
        }
        // Only an explicit purchase gate means billing is disabled. An HTTP
        // status alone cannot tell us whether the integration is configured.
        if (code === "BILLING_NOT_ENABLED") {
          return { kind: "unavailable", reason: "saas-not-enabled" };
        }
        return { kind: "unavailable", reason: "billing-forbidden" };
      }

      if ([
        "BILLING_NOT_CONFIGURED",
        "OBLIEN_WEBHOOK_NOT_CONFIGURED",
        "OBLIEN_DEFAULT_POLICY_REQUIRED",
        "OBLIEN_NAMESPACE_POLICY_REQUIRED",
      ].includes(code)) {
        return { kind: "unavailable", reason: "billing-not-configured" };
      }
    } else {
      logBillingFailure(null, "BILLING_FETCH_FAILED");
    }

    if (isLocalMode) {
      const connected = await fetchCloudConnected();
      return {
        kind: "unavailable",
        reason: connected ? "cloud-unreachable" : "cloud-not-connected",
      };
    }
    return { kind: "unavailable", reason: "billing-unreachable" };
  }
}

/** Pick a billing view only after an unscoped read reports multiple servers.
 * This uses the same authorized inventory as the picker, never a mutation default. */
export async function getDefaultBillingWorkspace(): Promise<string | undefined> {
  if ((await getDeploymentInfo()).selfHosted) return undefined;
  try {
    const data = await serverApi.get<{ servers: ServerDetail[] }>("system/servers/destinations", { cache: "no-store" });
    const servers = data.servers.filter(server => server.managed);
    // Prefer an allocated server (including stopped servers and previous
    // subscriptions) over an unfinished purchase. Provider state can lead the saved tier.
    const selected = servers.find(({ managed }) => managed && (managed.planTierId !== "free" || managed.resources)) ?? servers[0];
    return selected?.managed?.id;
  } catch {
    // Keep the explicit picker and its retry available if inventory cannot load.
    return undefined;
  }
}

// React.cache is request-scoped; billing data is never cached across customers.
export const getBillingPageState = cache(fetchBillingState);
