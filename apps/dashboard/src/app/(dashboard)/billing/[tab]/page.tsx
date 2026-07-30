import { notFound } from "next/navigation";
import type { PlanTierId } from "@repo/core";
import { CLOUD_CAPABILITIES } from "@repo/core";
import { BillingOverview } from "@/components/billing/BillingOverview";
import { BillingUsage } from "@/components/billing/BillingUsage";
import { BillingTopups } from "@/components/billing/BillingTopups";
import { BillingPlansRoute } from "../_components/BillingPlansRoute";
import { InvoicesPanel, PaymentMethodPanel } from "../_components/billing-shared";
import {
  BillingUnavailable,
  type BillingUnavailableReason,
} from "../_components/BillingUnavailable";
import { serverApi, ServerApiError } from "@/lib/server/api";
import { getDeploymentInfo } from "@/lib/server/session";
import type { BillingState } from "@/lib/api/billing";

interface BillingStateResponse {
  data: BillingState;
}

/**
 * Result envelope: either `state` (billing is reachable) OR a
 * `reason` (which empty-state to show). Reasons:
 *
 *   - `saas-not-enabled`   SaaS mode, 404/501 from /billing/state
 *   - `cloud-not-connected` local mode, no stored cloud session
 *                            (proxy returned 403 `cloud_not_connected`)
 *   - `cloud-unreachable`  local mode, cloud session present but
 *                            proxy got a 5xx or transport failure
 */
type BillingFetchResult =
  | { kind: "ok"; state: BillingState }
  | { kind: "unavailable"; reason: BillingUnavailableReason };

interface CloudStatus {
  connected: boolean;
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

async function fetchBillingState(): Promise<BillingFetchResult> {
  const info = await getDeploymentInfo();
  const isLocalMode = info.selfHosted;

  try {
    const res = await serverApi.get<BillingStateResponse>("billing/state", {
      cache: "no-store",
    });
    if (res?.data) {
      return { kind: "ok", state: res.data };
    }
    // Empty body — treat as not enabled.
    return {
      kind: "unavailable",
      reason: isLocalMode ? "cloud-unreachable" : "saas-not-enabled",
    };
  } catch (err) {
    if (err instanceof ServerApiError) {
      // 401 cloud_session_expired — token still stored locally, but
      // SaaS rejected it. User needs to re-authorize (NOT a full
      // disconnect/reconnect dance).
      if (err.status === 401) {
        const body = err.body as { code?: string } | null | undefined;
        if (body?.code === "cloud_session_expired") {
          return { kind: "unavailable", reason: "cloud-session-expired" };
        }
      }
      // 403 cloud_not_connected — local-mode proxy sentinel.
      if (err.status === 403) {
        const body = err.body as { code?: string } | null | undefined;
        if (body?.code === CLOUD_CAPABILITIES.billing.code) {
          return { kind: "unavailable", reason: "cloud-not-connected" };
        }
      }
      // 404 / 501 — SaaS mode without billing configured, OR a local
      // instance hitting a path that isn't wired (defensive: should
      // not happen now that the local proxy registers /state).
      if (err.status === 404 || err.status === 501) {
        if (!isLocalMode) {
          return { kind: "unavailable", reason: "saas-not-enabled" };
        }
        // Local mode + 404 means the local proxy isn't mounted — fall
        // back to "not connected" since that's the most likely cause.
        const connected = await fetchCloudConnected();
        return {
          kind: "unavailable",
          reason: connected ? "cloud-unreachable" : "cloud-not-connected",
        };
      }
      // 5xx and 502 — cloud reachable but errored.
      if (err.status >= 500) {
        if (isLocalMode) {
          const connected = await fetchCloudConnected();
          return {
            kind: "unavailable",
            reason: connected ? "cloud-unreachable" : "cloud-not-connected",
          };
        }
        return { kind: "unavailable", reason: "saas-not-enabled" };
      }
    }
    // Unknown — render unavailable with the best-fit reason.
    if (isLocalMode) {
      const connected = await fetchCloudConnected();
      return {
        kind: "unavailable",
        reason: connected ? "cloud-unreachable" : "cloud-not-connected",
      };
    }
    return { kind: "unavailable", reason: "saas-not-enabled" };
  }
}

export default async function BillingTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  const validTabs = ["overview", "usage", "plans", "topups", "payment", "invoices"];
  if (!validTabs.includes(tab)) {
    notFound();
  }

  const result = await fetchBillingState();

  if (result.kind === "unavailable") {
    return <BillingUnavailable reason={result.reason} />;
  }

  const state = result.state;

  switch (tab) {
    case "overview":
      return <BillingOverview state={state} />;
    case "usage":
      return <BillingUsage state={state} />;
    case "plans":
      return <BillingPlansRoute currentPlan={state.tier as PlanTierId} />;
    case "topups":
      return <BillingTopups state={state} />;
    case "payment":
      return <PaymentMethodPanel />;
    case "invoices":
      return <InvoicesPanel />;
    default:
      notFound();
  }
}
