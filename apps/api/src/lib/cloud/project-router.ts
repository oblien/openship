import { assertCloudProxyScope } from "@repo/platform/engine/lib/cloud/scope";
import { resolveProjectAuthority, type ProjectSource } from "@repo/platform/engine/lib/cloud/project-authority";
export { resolveProjectAuthority, type ProjectSource } from "@repo/platform/engine/lib/cloud/project-authority";
/** Authenticated Cloud transport and adapters for endpoints whose project
 * selector lives in a body/query. Resource routes use the secure router's
 * shared gateway, so new project/server actions cannot omit forwarding. */
import type { Context, Next } from "hono";
import { CLOUD_UNREACHABLE_CODE, type Capability } from "@repo/core";
import { authorization } from "@repo/platform/engine/lib/authorization";
import { env } from "@repo/platform/engine/config/index";
import { getRequestContext } from "../request-context";
import { cloudFetchAsOrgOwner } from "@repo/platform/engine/lib/cloud/transport";
import { cloudRequestReferences } from "@repo/platform/engine/lib/cloud/server-reference";

const SOURCE_HEADER = "X-Project-Source";

/**
 * Resolve whether a project id is served locally or proxied to the SaaS.
 * Returns "not-found" when there is no local row and no cloud link to proxy to.
 */
export async function resolveProjectSource(
  c: Context,
  projectId: string,
  organizationId: string,
): Promise<ProjectSource | "not-found"> {
  const hint = c.req.header(SOURCE_HEADER)?.toLowerCase();
  return resolveProjectAuthority(projectId, organizationId, hint === "cloud" || hint === "local" ? hint : undefined);
}

/**
 * Forward the current request to the SaaS as the org owner and return the SaaS
 * Response verbatim (streamed body — works for JSON and SSE alike).
 *
 * - Replaces the local organization header with the connection's pinned Cloud
 *   organization and bearer session. Local IDs never select a Cloud tenant.
 * - `null` from the transport (owner link gone / fetch failed) → 503, NOT 404:
 *   we only reach here when a cloud project was resolved, so a null means the
 *   cloud is unreachable, not that the project doesn't exist.
 */
export async function proxyToSaaS(
  c: Context,
  organizationId: string,
  opts?: { path?: string; body?: string },
): Promise<Response> {
  assertCloudProxyScope(getRequestContext(c));
  const url = new URL(c.req.url);
  const target = new URL(opts?.path ?? `${url.pathname}${url.search}`, url.origin);
  const refs = await cloudRequestReferences(organizationId, Object.fromEntries(target.searchParams));
  for (const field of ["serverId", "buildServerId", "workspaceId"]) {
    if (typeof refs[field] === "string") target.searchParams.set(field, refs[field]);
  }
  const path = `${target.pathname}${target.search}`;
  const method = c.req.method.toUpperCase();
  const contentType = c.req.header("content-type");

  const init: RequestInit = { method, signal: c.req.raw?.signal };
  if (method !== "GET" && method !== "HEAD") {
    // Prefer an explicit body (callers that already parsed it — e.g. the deploy
    // handlers read projectId from the body before branching); otherwise read
    // the raw request body.
    let body = opts?.body ?? (contentType?.includes("application/json")
      ? await c.req.text() : await c.req.arrayBuffer());
    if (typeof body === "string" && body && contentType?.includes("application/json")) {
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { /* Upstream applies the route's validation. */ }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = JSON.stringify(await cloudRequestReferences(organizationId, parsed as Record<string, unknown>));
    }
    if (typeof body === "string" ? body.length : body.byteLength) init.body = body;
  }
  // Only carry content-type; cloudFetch sets Authorization (owner bearer) and a
  // default Content-Type. We deliberately forward NO other headers — notably
  // not X-Organization-Id, cookies, or host.
  if (contentType) init.headers = { "Content-Type": contentType };

  const res = await cloudFetchAsOrgOwner(organizationId, path, init);
  if (!res) {
    return c.json(
      { error: "Openship Cloud is unreachable", code: CLOUD_UNREACHABLE_CODE },
      503,
    );
  }

  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

/**
 * For routes whose project id is in the BODY or QUERY (not a URL param) — deploy
 * create/build-access, domain add/list. Resolve the source and, if cloud, return
 * the proxied SaaS Response; otherwise return null so the caller runs the local
 * path. Pass `body` (already-parsed → re-serialized) for non-GET routes so the
 * proxy forwards it without re-reading the consumed request stream.
 *
 *   const proxied = await maybeProxyCloudProject(c, projectId, orgId, { body: JSON.stringify(body) });
 *   if (proxied) return proxied;
 *   // ...local path...
 */
export async function maybeProxyCloudProject(
  c: Context,
  projectId: string,
  organizationId: string,
  opts?: { body?: string },
): Promise<Response | null> {
  const source = await resolveProjectSource(c, projectId, organizationId);
  if (source === "cloud") return proxyToSaaS(c, organizationId, opts);
  return null;
}

/**
 * For routes that carry the project id in the QUERY (?projectId=) rather than a
 * URL param — e.g. /api/analytics/* and /api/deployments?projectId=. Proxies to
 * the SaaS when that project is cloud-owned; no-ops (runs locally) for org-wide
 * requests that carry no projectId. Mount after the permission middleware.
 */
export async function cloudProjectProxyByQuery(c: Context, next: Next, capability?: Capability): Promise<Response | void> {
  if (env.CLOUD_MODE) return next();
  const projectId = c.req.query("projectId");
  if (!projectId) return next(); // org-wide request — nothing project-specific to proxy
  const context = await authorization.authorize(getRequestContext(c), { resourceType: "project", resourceId: projectId, action: "read", ...(capability && { capability }) });
  c.set("scopedOrganizationId", context.organizationId);
  c.set("ctx", { ...context, hono: c });
  const organizationId = context.organizationId;
  const source = await resolveProjectSource(c, projectId, organizationId);
  if (source === "cloud") return proxyToSaaS(c, organizationId);
  return next();
}
