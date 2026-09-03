/**
 * DNS provider credential endpoints.
 *
 * No try/catch: every failure the service raises is an `AppError` subclass, so
 * `handleApiError` maps status + code centrally. A local `catch → 400` here would
 * flatten "Cloudflare is rate-limiting us" (502) and "you already have one of
 * those" (409) into the same unactionable response.
 */

import type { Context } from "hono";
import { NotFoundError } from "@repo/core";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { audit, auditContextFrom } from "../../lib/audit";
import { describeDnsProviders } from "./registry";
import * as dnsService from "./dns-credential.service";
import type { TAddDnsCredentialBody, TVerifyZoneBody } from "./dns.schema";

/** GET /dns/providers — supported providers and the token scopes they need. */
export async function listProviders(c: Context) {
  return c.json({ data: describeDnsProviders() });
}

/** GET /dns/credentials — connected credentials for the active organization. */
export async function listCredentials(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await dnsService.listCredentials(ctx.organizationId) });
}

/** GET /dns/credentials/:id — one connected credential. */
export async function getCredential(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const cred = await dnsService.getCredential(ctx.organizationId, id);
  if (!cred) throw new NotFoundError("DNS credential", id);
  return c.json({ data: cred });
}

/** GET /dns/credentials/:id/zones — list zones for this credential. */
export async function listZones(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const zones = await dnsService.listCredentialZones(ctx.organizationId, id);
  return c.json({ data: zones });
}

/** POST /dns/credentials — connect a provider credential. */
export async function addCredential(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TAddDnsCredentialBody>();

  const cred = await dnsService.addCredential(ctx.organizationId, body);

  // Label and provider only — the token is the thing being protected here, and
  // an audit row is exactly the sort of long-lived record it must never reach.
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "dns_credential.connected",
    resourceType: "dns_credential",
    resourceId: cred.id,
    after: { provider: cred.provider, name: cred.name },
  });

  return c.json({ data: cred }, 201);
}

/** DELETE /dns/credentials/:id — disconnect a credential. */
export async function removeCredential(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");

  // Read first so the audit row can name what was removed.
  const existing = await dnsService.getCredential(ctx.organizationId, id);
  if (!existing) throw new NotFoundError("DNS credential", id);

  await dnsService.removeCredential(ctx.organizationId, id);

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "dns_credential.disconnected",
    resourceType: "dns_credential",
    resourceId: id,
    before: { provider: existing.provider, name: existing.name },
  });

  return c.json({ success: true });
}

/**
 * POST /dns/verify-zone — can a connected provider manage this hostname?
 *
 * Read-only on purpose. The credential-invalidating write that used to sit on
 * this path belongs to provisioning: a check an operator runs to answer "will
 * this work" must not be able to disable their credential, and a route that
 * mutates can't honestly be declared `readOnly`.
 */
export async function verifyZone(c: Context) {
  const ctx = getRequestContext(c);
  const { hostname } = await c.req.json<TVerifyZoneBody>();

  const lookup = await dnsService.resolveDnsManager(ctx.organizationId, hostname);

  switch (lookup.status) {
    case "matched":
      return c.json({
        matched: true,
        status: "matched",
        provider: lookup.manager.provider.name,
        credentialId: lookup.manager.credentialId,
        zoneName: lookup.manager.zone.name,
        zoneId: lookup.manager.zone.id,
      });
    case "unauthorized":
      return c.json({
        matched: false,
        status: "unauthorized",
        credentialId: lookup.credentialId,
        message: lookup.reason,
      });
    case "unavailable":
      // Deliberately not "no provider manages this" — we could not ask.
      return c.json({ matched: false, status: "unavailable", message: lookup.reason });
    default:
      return c.json({
        matched: false,
        status: "none",
        message: "No connected DNS provider manages this domain's zone.",
      });
  }
}
