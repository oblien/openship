/**
 * Domain controller - Hono request handlers.
 */

import type { Context } from "hono";
import { safeErrorMessage } from "@repo/core";
import { param, assertNotCloud } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";
import { notification } from "../../lib/notification-dispatcher";
import { streamSSE } from "../../lib/sse";
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
  return c.json(
    {
      data: result.domain,
      records: result.records,
      ...(result.preexistingEdgeSite
        ? { preexistingEdgeSite: result.preexistingEdgeSite }
        : {}),
    },
    201,
  );
}

/** GET /domains/:id — one domain's verify + SSL state. */
export async function get(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(ctx, { resourceType: "domain", resourceId: id, action: "read" });
  const domain = await domainService.getDomain(ctx, id);
  return c.json({ data: domain });
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
  const force = c.req.query("force") === "1" || c.req.query("force") === "true";
  const result = await domainService.verifyDomain(ctx, id, { force });

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
      cnameVerified: result.cnameVerified,
      txtVerified: result.txtVerified,
    },
  });

  // Notify on failure. This is the non-streaming path used by the daily
  // re-verify cron + programmatic callers — the async case where a failure is
  // worth surfacing to the team. (The interactive `verifyStream` modal doesn't
  // notify: the person clicking is already watching the live result.)
  if (!result.verified) {
    notification.emit({
      organizationId: ctx.organizationId,
      eventType: "domain.verification_failed",
      resourceType: "domain",
      resourceId: id,
      payload: {
        message: result.message ?? "Domain verification failed",
        cnameVerified: result.cnameVerified,
        txtVerified: result.txtVerified,
      },
    });
  }

  // Failed verification returns 422 so the dashboard's React Query / fetch
  // wrapper can use the standard error path while still reading
  // message/cnameVerified/txtVerified from the body. 200 on success.
  return c.json(result, result.verified ? 200 : 422);
}

/**
 * POST /domains/:id/verify/stream (SSE) — self-hosted live-log verify. Streams
 * certbot's output line-by-line (`log`) as the standalone HTTP-01 challenge runs,
 * then a terminal `complete`. Same generic event contract the edge-setup modal
 * uses (`useSystemPrepareModal`), minus the consent prompt (verify never prompts).
 * The plain `verify` above stays for programmatic callers + the cron.
 */
export async function verifyStream(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(ctx, { resourceType: "domain", resourceId: id, action: "write" });

  return streamSSE(c, async (sse) => {
    let closed = false;
    // AWAIT each write. The terminal `complete` is the last thing sent before
    // this callback returns and Hono closes the SSE — a fire-and-forget
    // (`void writeSSE`) races that close and gets dropped, leaving the modal
    // spinning forever even though the backend already succeeded (the exact
    // "stuck after 'Certificate issued'" bug). Awaiting flushes it first.
    const emit = async (event: string, data: string) => {
      if (closed) return;
      try {
        await sse.writeSSE({ event, data });
      } catch {
        /* client disconnected */
      }
    };
    // The generic prepare modal expects a `session` event to start; verify has no
    // prompt to answer, so it's just the stream opener.
    await emit("session", JSON.stringify({ type: "session" }));
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    try {
      const result = await domainService.verifyDomain(ctx, id, {
        force,
        // Intermediate logs are fire-and-forget — they flush during the run.
        onLog: (line) => {
          void emit("log", JSON.stringify({ type: "log", message: line, level: "info" }));
        },
      });
      await emit(
        "log",
        JSON.stringify({
          type: "log",
          message: result.message ?? (result.verified ? "Verified." : "Not verified."),
          level: result.verified ? "info" : "error",
        }),
      );
      audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
        eventType: result.verified ? "domain.verified" : "domain.verify_failed",
        resourceType: "domain",
        resourceId: id,
        after: { verified: result.verified },
      });
      await emit("complete", JSON.stringify({ type: "complete", status: result.verified ? "completed" : "failed" }));
    } catch (err) {
      await emit("log", JSON.stringify({ type: "log", message: safeErrorMessage(err), level: "error" }));
      await emit("complete", JSON.stringify({ type: "complete", status: "failed" }));
    } finally {
      closed = true;
    }
  });
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
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ hostname: string; includeWww?: boolean }>();
  if (!body.hostname?.trim()) {
    return c.json({ error: "hostname is required" }, 400);
  }
  const result = await domainService.previewRecords(
    body.hostname.trim().toLowerCase(),
    ctx.organizationId,
    body.includeWww === true,
  );
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
  // SCOPED to the caller's org: pass ctx.organizationId so the sweep only sees
  // and re-verifies THIS org's pending domains. Without it the handler returned
  // every tenant's pending hostnames and triggered their DNS/SSL — a member of
  // one org has domain:write only in their OWN org, which must bound the WORK,
  // not just admit the request. The instance-wide sweep is the trusted system
  // `domains:verify-pending` cron (job.registry.ts), which calls the service
  // with no organizationId.
  const ctx = getRequestContext(c);
  type Body = { minAgeMinutes?: number; limit?: number };
  const body: Body = await c.req.json<Body>().catch(() => ({} as Body));
  const result = await domainService.verifyPendingDomains({
    minAgeMinutes: typeof body.minAgeMinutes === "number" ? body.minAgeMinutes : undefined,
    limit: typeof body.limit === "number" ? body.limit : undefined,
    organizationId: ctx.organizationId,
  });
  return c.json({ data: result });
}
