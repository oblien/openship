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
  const domain = await domainService.addDomain(userId, body);
  return c.json({ data: domain }, 201);
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

/** POST /domains/:id/renew — renew SSL for a single domain */
export async function renewSsl(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const result = await domainService.renewDomainSsl(id, userId);
  return c.json({ data: result });
}

/** POST /domains/renew-all — batch SSL renewal (admin / cron) */
export async function renewAllSsl(c: Context) {
  getUserId(c); // auth check
  const result = await domainService.renewExpiringCerts();
  return c.json({ data: result });
}
