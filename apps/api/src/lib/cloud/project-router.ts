/**
 * Project source-routing — the single place that answers "is this project id a
 * LOCAL project (served from the local DB) or a CLOUD project (canonical on the
 * SaaS, proxied)?", and runs the right arm.
 *
 * Model: cloud-deployed projects are canonical on the SaaS. A self-hosted
 * instance keeps NO local row for them; the local API is a gateway that proxies
 * their reads/writes to the SaaS as the org owner (cloudFetchAsOrgOwner). The
 * local permission plane still gates every call before it proxies — see
 * permission.ts. Local/server projects are served from the local DB as before.
 *
 * Source detection order:
 *   1. `X-Project-Source` header hint (the merged project list tags each row's
 *      source, so dashboard navigations carry it) — fast path, no DB read.
 *   2. Fallback: local `findById` hit → local; miss + org has a cloud link →
 *      cloud; miss + no link → not-found.
 *
 * Mode-aware: on the SaaS itself (CLOUD_MODE) every project IS local — there is
 * nothing upstream to proxy to — so the helper always resolves "local" there
 * and the same controller code is correct on both sides.
 *
 * Entry points (ALL proxy logic lives in this module — nowhere else):
 *   • cloudProjectProxy / cloudDeploymentProxy / cloudDomainProxy — route
 *     middleware for routes whose id is a URL param (:id / :projectId).
 *     Mount AFTER the permission middleware.
 *   • maybeProxyCloudProject — for routes whose project id is in the BODY/QUERY
 *     (deploy create/build-access, domain add/list). Call at the top of the
 *     handler; returns the proxied Response, or null to continue locally.
 *   • resolveProjectSource / proxyToSaaS — the underlying primitives.
 */
import type { Context, Next } from "hono";
import { CLOUD_UNREACHABLE_CODE } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../../config";
import { getRequestContext } from "../request-context";
import { cloudFetchAsOrgOwner, resolveOrgCloudUserId } from "./transport";

export type ProjectSource = "local" | "cloud";

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
  // On the SaaS we ARE the canonical store — never proxy.
  if (env.CLOUD_MODE) return "local";

  const hint = c.req.header(SOURCE_HEADER)?.toLowerCase();
  if (hint === "cloud") return "cloud";
  if (hint === "local") return "local";

  const local = await repos.project.findById(projectId).catch(() => null);
  if (local) return "local";

  // No local row — it's a cloud project iff the org has a cloud link to proxy
  // through. No link → genuinely not found (IDOR-safe: same 404 as a foreign id).
  const ownerUserId = await resolveOrgCloudUserId(organizationId).catch(() => null);
  return ownerUserId ? "cloud" : "not-found";
}

/**
 * Forward the current request to the SaaS as the org owner and return the SaaS
 * Response verbatim (streamed body — works for JSON and SSE alike).
 *
 * - Strips `X-Organization-Id`: the SaaS resolves the org from the owner's
 *   bearer session, never from a local-sent header. Forwarding the local org id
 *   would be meaningless (local org id != SaaS org id) and is a footgun.
 * - `null` from the transport (owner link gone / fetch failed) → 503, NOT 404:
 *   we only reach here when a cloud project was resolved, so a null means the
 *   cloud is unreachable, not that the project doesn't exist.
 */
export async function proxyToSaaS(
  c: Context,
  organizationId: string,
  opts?: { path?: string; body?: string },
): Promise<Response> {
  const url = new URL(c.req.url);
  const path = opts?.path ?? `${url.pathname}${url.search}`;
  const method = c.req.method.toUpperCase();

  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    // Prefer an explicit body (callers that already parsed it — e.g. the deploy
    // handlers read projectId from the body before branching); otherwise read
    // the raw request body.
    const body = opts?.body ?? (await c.req.text());
    if (body) init.body = body;
  }
  // Only carry content-type; cloudFetch sets Authorization (owner bearer) and a
  // default Content-Type. We deliberately forward NO other headers — notably
  // not X-Organization-Id, cookies, or host.
  const contentType = c.req.header("content-type");
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
 * Branch a per-project request: run `local` for a local project, else proxy to
 * the SaaS (the `cloud` arm defaults to `proxyToSaaS`). Returns 404 when neither
 * a local row nor a cloud link exists.
 *
 *   return withProjectSource(c, { projectId: id, organizationId }, {
 *     local: () => existingLocalHandler(c),
 *   });
 */
export async function withProjectSource(
  c: Context,
  opts: { projectId: string; organizationId: string },
  handlers: {
    local: () => Promise<Response> | Response;
    cloud?: () => Promise<Response> | Response;
  },
): Promise<Response> {
  const source = await resolveProjectSource(c, opts.projectId, opts.organizationId);
  if (source === "not-found") {
    return c.json({ error: "Project not found" }, 404);
  }
  if (source === "local") {
    return handlers.local();
  }
  return (handlers.cloud ?? (() => proxyToSaaS(c, opts.organizationId)))();
}

/**
 * Route middleware for per-`:id` PROJECT routes (the `:id` param is the project
 * id). Mount it AFTER the permission middleware so the gate has run and
 * `ctx.organizationId` is rebound to the resolved org:
 *
 *   r.get("/:id/info", { tag: "project:read" }, cloudProjectProxy, ctrl.getInfo)
 *
 * For a CLOUD project it proxies the whole request to the SaaS and returns that
 * response (short-circuiting the local handler — and, since it runs inside the
 * permission middleware's `next()`, the local audit event still fires). For a
 * LOCAL project it falls through to the local handler. `proxyToSaaS` only reads
 * the body when it actually proxies, so this is safe on GET and mutating routes
 * alike.
 */
export async function cloudProjectProxy(c: Context, next: Next): Promise<Response | void> {
  // Most project-scoped routes use `:id`; some sub-routers (e.g. backups) mount
  // under `:projectId`. Accept either — both name the owning project.
  const id = c.req.param("id") ?? c.req.param("projectId");
  if (!id) return next();
  const organizationId = getRequestContext(c).organizationId;
  const source = await resolveProjectSource(c, id, organizationId);
  if (source === "cloud") return proxyToSaaS(c, organizationId);
  // "local" or "not-found": let the local handler run (it 404s a genuine miss).
  return next();
}

/**
 * Like cloudProjectProxy but keyed on a DEPLOYMENT `:id` (standalone deployment
 * routes — /api/deployments/:id/...). Source detection uses the deployment row
 * (not the project row), since the `:id` is a deployment id: hint header first,
 * then local `deployment.findById` (hit → local), then miss + cloud link →
 * cloud. Mount after the permission middleware.
 */
export async function cloudDeploymentProxy(c: Context, next: Next): Promise<Response | void> {
  const id = c.req.param("id");
  if (!id || env.CLOUD_MODE) return next();
  const organizationId = getRequestContext(c).organizationId;

  const hint = c.req.header(SOURCE_HEADER)?.toLowerCase();
  if (hint === "local") return next();
  if (hint !== "cloud") {
    const dep = await repos.deployment.findById(id).catch(() => null);
    if (dep) return next(); // local deployment
    const ownerUserId = await resolveOrgCloudUserId(organizationId).catch(() => null);
    if (!ownerUserId) return next(); // no cloud link → let the local handler 404
  }
  return proxyToSaaS(c, organizationId);
}

/**
 * Like cloudDeploymentProxy but keyed on a DOMAIN `:id` (standalone domain
 * routes — /api/domains/:id/...). Hint header first, then local
 * `domain.findById` (hit → local), then miss + cloud link → cloud.
 */
export async function cloudDomainProxy(c: Context, next: Next): Promise<Response | void> {
  const id = c.req.param("id");
  if (!id || env.CLOUD_MODE) return next();
  const organizationId = getRequestContext(c).organizationId;

  const hint = c.req.header(SOURCE_HEADER)?.toLowerCase();
  if (hint === "local") return next();
  if (hint !== "cloud") {
    const dom = await repos.domain.findById(id).catch(() => null);
    if (dom) return next(); // local domain
    const ownerUserId = await resolveOrgCloudUserId(organizationId).catch(() => null);
    if (!ownerUserId) return next(); // no cloud link → let the local handler 404
  }
  return proxyToSaaS(c, organizationId);
}

/**
 * For routes that carry the project id in the QUERY (?projectId=) rather than a
 * URL param — e.g. /api/analytics/* and /api/deployments?projectId=. Proxies to
 * the SaaS when that project is cloud-owned; no-ops (runs locally) for org-wide
 * requests that carry no projectId. Mount after the permission middleware.
 */
export async function cloudProjectProxyByQuery(c: Context, next: Next): Promise<Response | void> {
  if (env.CLOUD_MODE) return next();
  const projectId = c.req.query("projectId");
  if (!projectId) return next(); // org-wide request — nothing project-specific to proxy
  const organizationId = getRequestContext(c).organizationId;
  const source = await resolveProjectSource(c, projectId, organizationId);
  if (source === "cloud") return proxyToSaaS(c, organizationId);
  return next();
}
