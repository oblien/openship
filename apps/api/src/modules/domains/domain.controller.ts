/**
 * Domain controller — Hono request handlers.
 */

import type { Context } from "hono";
import { getUserId, param } from "../../lib/controller-helpers";
import * as domainService from "./domain.service";
import type { TAddDomainBody } from "./domain.schema";

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function list(c: Context) {
  const userId = getUserId(c);
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return c.json({ error: "projectId query parameter required" }, 400);
  }
  const domains = await domainService.listDomains(projectId, userId);
  return c.json({ data: domains });
}

export async function add(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<TAddDomainBody>();
  const result = await domainService.addDomain(userId, body);
  return c.json({ data: result.domain, records: result.records }, 201);
}

export async function remove(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  await domainService.removeDomain(id, userId);
  return c.json({ message: "domain removed" });
}

export async function verify(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const result = await domainService.verifyDomain(id, userId);
  return c.json(result);
}

export async function records(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const result = await domainService.getDomainRecords(id, userId);
  return c.json({ data: result });
}

/** POST /domains/preview — get DNS records for a hostname (no DB write) */
export async function preview(c: Context) {
  const body = await c.req.json<{ hostname: string }>();
  if (!body.hostname?.trim()) {
    return c.json({ error: "hostname is required" }, 400);
  }
  const result = await domainService.previewRecords(body.hostname.trim().toLowerCase());
  return c.json({ data: result });
}

/** POST /domains/:id/renew — renew SSL for a single domain */
export async function renewSsl(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const result = await domainService.renewDomainSsl(id, userId);
  return c.json({ data: result });
}

/** POST /domains/renew-all — batch SSL renewal for the requesting user's domains */
export async function renewAllSsl(c: Context) {
  const userId = getUserId(c);
  const result = await domainService.renewUserCerts(userId);
  return c.json({ data: result });
}
