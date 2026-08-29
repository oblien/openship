/**
 * Credential endpoints.
 *
 * No try/catch: every failure the service raises is an `AppError` subclass, so
 * `handleApiError` maps status + code centrally. A local `catch → 400` would flatten "the
 * registry rejected this login" (400), "you already have one called that" (409) and "no
 * such credential" (404) into one unactionable response.
 *
 * AUDIT RECORDS CARRY NO SECRET — not the value, not a prefix, not its length. Provider,
 * label and selector only: an audit row is the longest-lived record in the system and the
 * exact place a credential must never reach.
 */

import type { Context } from "hono";
import { CREDENTIAL_PROVIDERS } from "@repo/core";

import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { audit, auditContextFrom } from "../../lib/audit";
import * as service from "./credential.service";
import { hasVerifier } from "./verify";
import type { TCreateCredentialBody, TUpdateCredentialBody } from "./credential.schema";

/**
 * GET /credentials/providers — the catalogue the settings form renders from.
 *
 * Serves the registry as-is (labels, field schema, selector, logo slug) so the client has
 * no second copy of it. A provider Openship cannot verify yet is filtered out: the service
 * refuses to store one, and offering it in the picker would be a form that always fails.
 */
export async function listProviders(c: Context) {
  return c.json({
    data: CREDENTIAL_PROVIDERS.filter((p) => hasVerifier(p.id)),
  });
}

/** GET /credentials — every credential for the active organization, masked. */
export async function listCredentials(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await service.listCredentials(ctx.organizationId) });
}

/** GET /credentials/:id — one credential, masked. */
export async function getCredential(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await service.getCredential(ctx.organizationId, param(c, "id")) });
}

/** POST /credentials — store a credential, after the provider accepts it. */
export async function createCredential(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TCreateCredentialBody>();

  const cred = await service.createCredential(ctx.organizationId, body);

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "credential.created",
    resourceType: "credential",
    resourceId: cred.id,
    after: { provider: cred.provider, name: cred.name, selector: cred.selector },
  });

  return c.json({ data: cred }, 201);
}

/** PATCH /credentials/:id — rename, re-scope, or rotate the secret. */
export async function updateCredential(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const before = await service.getCredential(ctx.organizationId, id);
  const body = await c.req.json<TUpdateCredentialBody>();

  const cred = await service.updateCredential(ctx.organizationId, id, body);

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "credential.updated",
    resourceType: "credential",
    resourceId: cred.id,
    before: { name: before.name, selector: before.selector },
    // `secretRotated` rather than anything about the secret itself: whether it changed is
    // the operationally useful fact, and the only one that is safe to keep.
    after: {
      name: cred.name,
      selector: cred.selector,
      secretRotated: Object.keys(body.values ?? {}).length > 0,
    },
  });

  return c.json({ data: cred });
}

/** DELETE /credentials/:id — remove it. */
export async function deleteCredential(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const before = await service.getCredential(ctx.organizationId, id);

  await service.deleteCredential(ctx.organizationId, id);

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "credential.deleted",
    resourceType: "credential",
    resourceId: id,
    before: { provider: before.provider, name: before.name, selector: before.selector },
  });

  return c.json({ success: true });
}

/**
 * POST /credentials/:id/verify — re-check a stored credential with its provider.
 *
 * A write, despite reading like a probe: it records the verdict, which is how a credential
 * revoked upstream becomes visible instead of failing every deploy in silence.
 */
export async function verifyCredential(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");

  const cred = await service.verifyCredential(ctx.organizationId, id);

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "credential.verified",
    resourceType: "credential",
    resourceId: id,
    after: { provider: cred.provider, name: cred.name, status: cred.status },
  });

  return c.json({ data: cred });
}
