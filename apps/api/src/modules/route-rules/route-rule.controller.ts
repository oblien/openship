/**
 * Route rules controller — per-project edge rules (rate-limit · ban · allow/deny).
 *
 *   GET    /api/projects/:id/route-rules
 *   POST   /api/projects/:id/route-rules
 *   PATCH  /api/projects/:id/route-rules/:ruleId
 *   DELETE /api/projects/:id/route-rules/:ruleId
 *
 * Self-hosted only (mounted behind localOnly). The DB is the source of truth;
 * every mutation re-pushes the project's rules to its OpenResty edge (reload-free).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import type { RouteRuleSpec } from "@repo/core";
import { safeErrorMessage } from "@repo/core";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import { pushProjectRulesResolved } from "./route-rule.service";

/** HTTP methods accepted in an access method allow-list. */
const HTTP_METHODS = new Set([
  "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT",
]);
/** Response codes a rule may return on block (keeps arbitrary/odd codes out). */
const BLOCK_STATUSES = new Set([401, 403, 404, 429, 444, 451, 503]);

/**
 * Sanitize a client-supplied spec into the trusted RouteRuleSpec shape.
 * Everything is allow-listed/clamped here so the edge only ever sees validated
 * data: no control chars (CRLF/header-injection), bounded list/string sizes,
 * ISO-2 countries, known methods/statuses. The Lua guard treats every value as
 * data (never a pattern), but we still normalize defensively at the boundary.
 */
function sanitizeSpec(input: unknown): RouteRuleSpec {
  const spec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: RouteRuleSpec = {};

  // Reject empty/oversized/control-char strings; cap list length.
  const strList = (v: unknown, maxLen = 64): string[] | undefined =>
    Array.isArray(v)
      ? v
          .filter(
            (s): s is string =>
              typeof s === "string" &&
              s.length > 0 &&
              s.length <= maxLen &&
              !/[\u0000-\u001f\u007f]/.test(s),
          )
          .slice(0, 256)
      : undefined;

  const country2 = (list?: string[]) =>
    list?.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));

  const rl = spec.rateLimit as Record<string, unknown> | undefined;
  if (rl && typeof rl === "object") {
    const rps = Number(rl.rps);
    const burst = Number(rl.burst);
    const status = Number(rl.status);
    if (Number.isFinite(rps) && rps > 0) {
      out.rateLimit = {
        rps: Math.floor(rps),
        burst: Number.isFinite(burst) && burst >= 0 ? Math.floor(burst) : 0,
        key: "ip",
        ...(BLOCK_STATUSES.has(status) ? { status } : {}),
      };
    }
  }

  const banIn = spec.ban as Record<string, unknown> | undefined;
  if (banIn && typeof banIn === "object") {
    const ban: NonNullable<RouteRuleSpec["ban"]> = {};
    const ips = strList(banIn.ips);
    const cidrs = strList(banIn.cidrs);
    const countries = country2(strList(banIn.countries));
    const userAgents = strList(banIn.userAgents, 128);
    if (ips?.length) ban.ips = ips;
    if (cidrs?.length) ban.cidrs = cidrs;
    if (countries?.length) ban.countries = countries;
    if (userAgents?.length) ban.userAgents = userAgents;
    if (banIn.emptyUserAgent === true) ban.emptyUserAgent = true;
    if (Object.keys(ban).length) out.ban = ban;
  }

  const accessIn = spec.access as Record<string, unknown> | undefined;
  if (accessIn && typeof accessIn === "object") {
    const access: NonNullable<RouteRuleSpec["access"]> = {};
    const allow = strList(accessIn.allowCidrs);
    const deny = strList(accessIn.denyCidrs);
    const allowCountries = country2(strList(accessIn.allowCountries));
    const methods = strList(accessIn.methods, 12)
      ?.map((m) => m.toUpperCase())
      .filter((m) => HTTP_METHODS.has(m));
    if (allow?.length) access.allowCidrs = allow;
    if (deny?.length) access.denyCidrs = deny;
    if (allowCountries?.length) access.allowCountries = allowCountries;
    if (methods?.length) access.methods = Array.from(new Set(methods));
    if (Object.keys(access).length) out.access = access;
  }

  const hotIn = spec.hotlink as Record<string, unknown> | undefined;
  if (hotIn && typeof hotIn === "object") {
    const referers = strList(hotIn.allowReferers, 253)?.map((h) => h.toLowerCase());
    if (referers?.length) {
      out.hotlink = { allowReferers: referers, allowEmpty: hotIn.allowEmpty !== false };
    }
  }

  const blockStatus = Number((spec.block as Record<string, unknown> | undefined)?.status);
  if (BLOCK_STATUSES.has(blockStatus)) out.block = { status: blockStatus };

  return out;
}

function normalizePathPrefix(p: string | null | undefined): string | null {
  if (!p) return null;
  const s = p.trim();
  if (!s || s === "/") return null;
  const withSlash = s.startsWith("/") ? s : `/${s}`;
  return withSlash.slice(0, 512);
}

async function loadProject(c: Context) {
  const organizationId = getRequestContext(c).organizationId;
  const project = await repos.project.findById(param(c, "id"));
  if (!project || project.organizationId !== organizationId) return null;
  return project;
}

async function repush(projectId: string) {
  await pushProjectRulesResolved(projectId).catch((err) =>
    console.warn(`[route-rules] push failed: ${safeErrorMessage(err)}`),
  );
}

export async function listRouteRules(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const rules = await repos.routeRule.listByProject(project.id);
  return c.json({ rules });
}

export async function createRouteRule(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json<{
    domainId?: string | null;
    pathPrefix?: string | null;
    spec?: unknown;
    enabled?: boolean;
  }>();

  if (body.domainId) {
    const dom = await repos.domain.findById(body.domainId);
    if (!dom || dom.projectId !== project.id) {
      return c.json({ error: "domainId does not belong to this project" }, 400);
    }
  }

  const rule = await repos.routeRule.create({
    organizationId: project.organizationId,
    projectId: project.id,
    domainId: body.domainId ?? null,
    pathPrefix: normalizePathPrefix(body.pathPrefix),
    spec: sanitizeSpec(body.spec),
    enabled: body.enabled ?? true,
  });

  await repush(project.id);
  return c.json({ rule }, 201);
}

export async function updateRouteRule(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const ruleId = param(c, "ruleId");
  const existing = await repos.routeRule.get(ruleId);
  if (!existing || existing.projectId !== project.id) {
    return c.json({ error: "Rule not found" }, 404);
  }

  const body = await c.req.json<{
    domainId?: string | null;
    pathPrefix?: string | null;
    spec?: unknown;
    enabled?: boolean;
  }>();

  const patch: Record<string, unknown> = {};
  if (body.domainId !== undefined) {
    if (body.domainId) {
      const dom = await repos.domain.findById(body.domainId);
      if (!dom || dom.projectId !== project.id) {
        return c.json({ error: "domainId does not belong to this project" }, 400);
      }
    }
    patch.domainId = body.domainId ?? null;
  }
  if (body.pathPrefix !== undefined) patch.pathPrefix = normalizePathPrefix(body.pathPrefix);
  if (body.spec !== undefined) patch.spec = sanitizeSpec(body.spec);
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;

  await repos.routeRule.update(ruleId, patch);
  await repush(project.id);
  const rule = await repos.routeRule.get(ruleId);
  return c.json({ rule });
}

export async function deleteRouteRule(c: Context) {
  const project = await loadProject(c);
  if (!project) return c.json({ error: "Project not found" }, 404);

  await repos.routeRule.removeForProject(project.id, param(c, "ruleId"));
  await repush(project.id);
  return c.json({ success: true });
}
