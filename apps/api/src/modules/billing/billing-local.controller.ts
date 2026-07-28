/**
 * Local billing controller - runs only when !CLOUD_MODE.
 *
 * Proxies billing operations to the SaaS API via cloudClient,
 * following the same pattern as cloud-local.controller.ts.
 *
 * The user's cloud session is server-side only (encrypted in DB).
 * Dynamic import ensures cloud-client is never loaded in SaaS mode.
 *
 * Auth model — proxy uses the org-owner's stored cloud session bearer.
 * Billing is org-scoped on the SaaS (Stripe customer lives on the
 * `organization` row), so a teammate hitting these endpoints still
 * resolves correctly through the org-owner's cloud link. Returns 403
 * `cloud_not_connected` when no org member has linked cloud.
 *
 * No caching — billing is cloud-source-of-truth, every call proxies.
 */

import type { Context } from "hono";
import { CLOUD_CAPABILITIES } from "@repo/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RequestContext } from "../../lib/request-context";
import { getRequestContext } from "../../lib/request-context";

type ProxyResult = { status: ContentfulStatusCode; payload: unknown };

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
async function proxyToCloudBilling(
  ctx: RequestContext,
  path: string,
  method: string = "GET",
  body?: string,
): Promise<ProxyResult> {
  const { cloudClient } = await import("../../lib/cloud/client");

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

  return { status: res.status as ContentfulStatusCode, payload };
}

/* ---------- Billing state (dashboard overview) ---------- */

export async function getState(c: Context) {
  const ctx = getRequestContext(c);
  const { status, payload } = await proxyToCloudBilling(ctx, "/state");
  return c.json(payload, status);
}

/* ---------- Subscriptions ---------- */

export async function getSubscription(c: Context) {
  const ctx = getRequestContext(c);
  const { status, payload } = await proxyToCloudBilling(ctx, "/subscription");
  return c.json(payload, status);
}

export async function createSubscription(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.text();
  const { status, payload } = await proxyToCloudBilling(
    ctx,
    "/subscription",
    "POST",
    body,
  );
  return c.json(payload, status);
}

export async function cancelSubscription(c: Context) {
  // SaaS exposes cancellation as POST /cancel (not DELETE /subscription).
  const ctx = getRequestContext(c);
  const body = await c.req.text();
  const { status, payload } = await proxyToCloudBilling(
    ctx,
    "/cancel",
    "POST",
    body,
  );
  return c.json(payload, status);
}

/* ---------- Usage ---------- */

export async function getUsage(c: Context) {
  const ctx = getRequestContext(c);
  const qs = c.req.raw.url.split("?")[1];
  const { status, payload } = await proxyToCloudBilling(
    ctx,
    qs ? `/usage?${qs}` : "/usage",
  );
  return c.json(payload, status);
}

/* ---------- Top-ups ---------- */

export async function listTopupPacks(c: Context) {
  const ctx = getRequestContext(c);
  const { status, payload } = await proxyToCloudBilling(ctx, "/topup-packs");
  return c.json(payload, status);
}

export async function createTopup(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.text();
  const { status, payload } = await proxyToCloudBilling(
    ctx,
    "/topup",
    "POST",
    body,
  );
  return c.json(payload, status);
}

/* ---------- Portal ---------- */
//
// The dashboard routes payment-method management AND invoice listing
// through Stripe's hosted portal (POST /portal returns a one-shot
// redirect URL). There is no first-party /payment-methods or
// /invoices on the SaaS side — proxying those would hit a 404 HTML
// page from openresty and break dashboard JSON handling.

export async function createPortal(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.text();
  const { status, payload } = await proxyToCloudBilling(
    ctx,
    "/portal",
    "POST",
    body,
  );
  return c.json(payload, status);
}
