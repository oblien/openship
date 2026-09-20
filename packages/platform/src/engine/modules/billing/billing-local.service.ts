import { CLOUD_CAPABILITIES } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { assertCloudTenantScope } from "../../lib/cloud/scope";

type ProxyResult = { status: number; payload: unknown };

/**
 * Forward a billing request to the SaaS as the active org's cloud link.
 *
 * Pure helper — takes only RequestContext + explicit args, returns
 * `{status, payload}`. Controllers own the c.json conversion. No
 * dependency on Hono is hidden inside this function.
 *
 * Return shapes:
 *   - SaaS responded     — its status + parsed JSON body, verbatim.
 *   - 403 `cloud_not_connected`     — no org member has linked Cloud.
 *   - 401 `cloud_session_expired`   — SaaS returned 401; the user must reconnect.
 *   - 502 `cloud_unreachable`       — network/transport failure reaching SaaS.
 *   - 502 `cloud_invalid_response`  — SaaS returned non-JSON.
 */
export async function proxyToCloudBilling(
  ctx: ExecutionContext,
  path: string,
  method: string = "GET",
  body?: string,
): Promise<ProxyResult> {
  assertCloudTenantScope(ctx);
  const { cloudClient } = await import("@repo/platform/engine/lib/cloud/client");

  let res: Response | null;
  try {
    res = await cloudClient({ organizationId: ctx.organizationId }).request(
      `/api/billing${path}`,
      { method, body },
    );
  } catch (err) {
    console.warn(
      `[billing-local] cloud request threw for ${method} ${path}: ${(err as Error).message}`,
    );
    return {
      status: 502,
      payload: {
        error: "Couldn't reach Openship Cloud billing.",
        code: "cloud_unreachable",
      },
    };
  }

  if (!res) {
    return {
      status: 403,
      payload: {
        error: "Not connected to Openship Cloud.",
        // Single-sourced from the shared cloud-capability registry.
        code: CLOUD_CAPABILITIES.billing.code,
      },
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return {
      status: 502,
      payload: {
        error: "Cloud billing returned a non-JSON response.",
        code: "cloud_invalid_response",
      },
    };
  }

  if (res.status === 401) {
    console.warn(
      `[billing-local] SaaS returned 401 for ${method} /api/billing${path}; stored cloud session left intact.`,
    );
    return {
      status: 401,
      payload: {
        error: "Your Openship Cloud session has expired. Please reconnect.",
        code: "cloud_session_expired",
        upstream: payload,
      },
    };
  }

  return { status: res.status as number, payload };
}

