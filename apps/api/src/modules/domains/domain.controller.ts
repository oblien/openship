/**
 * Domain controller - Hono request handlers.
 */

import type { Context } from "hono";
import { param, assertNotCloud } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";
import * as domainService from "./domain.service";
import { maybeProxyCloudProject } from "../../lib/cloud/project-router";
import type { TAddDomainBody, TUploadCertBody } from "./domain.schema";

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function list(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return c.json({ error: "projectId query parameter required" }, 400);
  }
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: projectId, action: "read" });
  const proxied = await maybeProxyCloudProject(c, projectId, getRequestContext(c).organizationId);
  if (proxied) return proxied;
  const domains = await domainService.listDomains(ctx, projectId);
  return c.json({ data: domains });
}

export async function add(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TAddDomainBody>();
  if (body.projectId) {
    await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: body.projectId, action: "write" });
    const proxied = await maybeProxyCloudProject(c, body.projectId, getRequestContext(c).organizationId, {
      body: JSON.stringify(body),
    });
    if (proxied) return proxied;
  }
  const result = await domainService.addDomain(ctx, body);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "domain.added",
    resourceType: "domain",
    resourceId: result.domain.id,
    after: {
      projectId: result.domain.projectId,
      hostname: result.domain.hostname,
      isPrimary: result.domain.isPrimary,
    },
  });
  return c.json({ data: result.domain, records: result.records }, 201);
}

export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "domain", resourceId: id, action: "admin" });
  await domainService.removeDomain(ctx, id);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "domain.removed",
    resourceType: "domain",
    resourceId: id,
    after: null,
  });
  return c.json({ message: "domain removed" });
}

export async function verify(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "domain", resourceId: id, action: "write" });
  const result = await domainService.verifyDomain(ctx, id);

  // Audit verify attempts (both success and failure) so DNS verification
  // is traceable in the audit log alongside domain.added / domain.removed.
  // Useful for incident response — if a domain is hijacked via brief CNAME
  // control, the audit trail shows exactly when and from where the verify
  // ran.
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: result.verified ? "domain.verified" : "domain.verify_failed",
    resourceType: "domain",
    resourceId: id,
    after: {
      verified: result.verified,
      recordVerified: result.recordVerified,
      cnameVerified: result.cnameVerified,
      txtVerified: result.txtVerified,
    },
  });

  // Failed verification returns 422 so the dashboard's React Query / fetch
  // wrapper can use the standard error path while still reading
  // message/recordVerified/txtVerified from the body. cnameVerified remains a
  // compatibility alias for older dashboard builds. 200 on success.
  return c.json(result, result.verified ? 200 : 422);
}

export async function records(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "domain", resourceId: id, action: "read" });
  const result = await domainService.getDomainRecords(ctx, id);
  return c.json({ data: result });
}

/** POST /domains/:id/primary - make this domain the project's primary */
export async function setPrimary(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "domain", resourceId: id, action: "write" });
  const domain = await domainService.setPrimaryDomain(ctx, id);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "domain.set_primary",
    resourceType: "domain",
    resourceId: id,
    after: { projectId: domain.projectId, hostname: domain.hostname, isPrimary: true },
  });
  return c.json({ data: domain });
}

/** POST /domains/preview - get DNS records for a hostname (no DB write) */
export async function preview(c: Context) {
  const body = await c.req.json<{ hostname: string }>();
  if (!body.hostname?.trim()) {
    return c.json({ error: "hostname is required" }, 400);
  }
  const result = await domainService.previewRecords(body.hostname.trim().toLowerCase());
  return c.json({ data: result });
}

/** POST /domains/:id/renew - renew SSL for a single domain */
export async function renewSsl(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "domain", resourceId: id, action: "write" });
  const result = await domainService.renewDomainSsl(ctx, id);
  return c.json({ data: result });
}

/** POST /domains/:id/verify-ssl - read-only recheck that the cert is issued/valid */
export async function verifySsl(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "domain", resourceId: id, action: "write" });
  const result = await domainService.verifyDomainSsl(ctx, id);
  return c.json({ data: result });
}

/** POST /domains/:id/certificate - install an operator-supplied cert (BYO / Origin CA) */
export async function uploadCert(c: Context) {
  // Self-hosted only: installing an operator-supplied cert writes to the box's
  // OpenResty. On Openship Cloud, TLS is owned by the managed edge — there's
  // nothing to install, so refuse rather than run a no-op/misleading path.
  const guard = assertNotCloud(c);
  if (guard) return guard;

  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "domain", resourceId: id, action: "write" });
  const body = await c.req.json<TUploadCertBody>();
  const result = await domainService.uploadDomainCert(ctx, id, body);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "domain.cert_uploaded",
    resourceType: "domain",
    resourceId: id,
    // Never log the cert/key material — just the outcome.
    after: { domain: result.domain, issuer: result.issuer, expiresAt: result.expiresAt },
  });
  return c.json({ data: result });
}

/** POST /domains/renew-all - batch SSL renewal for the requesting org's domains */
export async function renewAllSsl(c: Context) {
  const ctx = getRequestContext(c);
  const result = await domainService.renewOrgCerts(ctx);
  return c.json({ data: result });
}

/**
 * POST /domains/verify-pending - admin/cron endpoint.
 *
 * Re-runs DNS verification for every custom domain still in `pending`
 * state and added more than `minAgeMinutes` ago. Wire this up to a
 * scheduled job (Kubernetes CronJob / systemd timer / external scheduler)
 * so domains whose DNS finishes propagating after the user closed the
 * tab eventually flip to verified without manual re-clicks.
 *
 * Body: { minAgeMinutes?: number; limit?: number }
 */
export async function verifyPending(c: Context) {
  // Auth is the standard authMiddleware applied at the routes file —
  // any logged-in user can trigger a run; the work itself runs against
  // each domain's own project owner via verifyDomain, so the requester
  // can only kick off the sweep, not cross-tenant verify.
  type Body = { minAgeMinutes?: number; limit?: number };
  const body: Body = await c.req.json<Body>().catch(() => ({} as Body));
  const result = await domainService.verifyPendingDomains({
    minAgeMinutes: typeof body.minAgeMinutes === "number" ? body.minAgeMinutes : undefined,
    limit: typeof body.limit === "number" ? body.limit : undefined,
  });
  return c.json({ data: result });
}
