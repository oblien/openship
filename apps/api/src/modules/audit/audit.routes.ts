/**
 * Audit log API — mounted at /api/audit.
 *
 * GET    /api/audit           list events for the active organization
 * GET    /api/audit/facets    filter options + per-tab counts for the UI
 * GET    /api/audit/settings  recording switch + retention
 * PATCH  /api/audit/settings  change them
 *
 * Filters on the list: `category` (expanded to its event types through the
 * shared taxonomy — a category is not a column), `eventType`, `actorUserId`,
 * `source`, `resourceType`, `resourceId`, `from`/`to`, and `q`.
 *
 * `q` is deliberately more than an `event_type LIKE`: rows store ids, so
 * searching "api-gateway" resolves the term against project/server/domain names
 * FIRST and passes the matching ids down as extra id predicates. Without that,
 * the only searchable text in an audit row is the event type itself.
 *
 * All requests are scoped by the caller's active organization. `audit` is an
 * org-singleton resource, so the route tags below resolve to exactly the
 * `{audit, "*", read|write}` assertion the handlers used to make by hand:
 * owners/admins allowed, members denied outright, restricted principals gated
 * through an explicit grant.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { repos } from "@repo/db";
import {
  AUDIT_CATEGORIES,
  categoryForAuditEvent,
  eventTypesForCategory,
  isAuditCategoryId,
} from "@repo/core";
import { secureRouter } from "../../lib/secure-router";
import { getRequestContext } from "../../lib/request-context";
import { checkPermissionOnResource } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";
import { isAuditSource } from "../../lib/call-source";

const r = secureRouter(new Hono(), { module: "audit", basePath: "/api/audit" });

/** Retention windows the UI offers. Anything else is rejected. */
const RETENTION_CHOICES = [7, 30, 90, 180, 365] as const;

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/**
 * Ids of named resources matching a free-text term, so `q` can find rows that
 * only ever stored an opaque id. Capped per type; a term matching thousands of
 * projects degrades to "matches the first 200", which is preferable to a
 * predicate list long enough to slow the query down.
 */
async function resolveSearchResourceIds(organizationId: string, term: string): Promise<string[]> {
  const [projects, servers, domains] = await Promise.all([
    repos.project.searchIdsByName(organizationId, term).catch(() => []),
    repos.server.searchIdsByName(organizationId, term).catch(() => []),
    repos.domain.searchIdsByHostname(organizationId, term).catch(() => []),
  ]);
  return Array.from(new Set([...projects, ...servers, ...domains]));
}

/** The filter set shared by the list and the facet counts. */
async function filtersFromQuery(c: Context, organizationId: string) {
  const category = c.req.query("category");
  const eventType = c.req.query("eventType");
  const source = c.req.query("source");
  const q = c.req.query("q")?.trim();

  return {
    eventType: eventType || undefined,
    // An unknown category yields an empty list, which the repo ignores — the
    // request degrades to unfiltered rather than 400-ing on a stale bookmark.
    eventTypes:
      category && category !== "all" && isAuditCategoryId(category)
        ? eventTypesForCategory(category)
        : undefined,
    actorUserId: c.req.query("actorUserId") || undefined,
    resourceType: c.req.query("resourceType") || undefined,
    resourceId: c.req.query("resourceId") || undefined,
    source: source && isAuditSource(source) ? source : undefined,
    from: parseDate(c.req.query("from")),
    to: parseDate(c.req.query("to")),
    q: q || undefined,
    qResourceIds: q ? await resolveSearchResourceIds(organizationId, q) : undefined,
  };
}

type AuditRow = Awaited<ReturnType<typeof repos.auditEvent.listByOrganization>>["rows"][number];

/**
 * Attach `resourceName` to a page of rows: one batched lookup per resource type
 * present, never one per row. Failures leave the name null — the UI falls back
 * to a generic noun, which is worse than a name and much better than a 500.
 */
async function attachResourceNames(rows: AuditRow[]): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.resourceType || !row.resourceId || row.resourceId === "*") continue;
    const bucket = byType.get(row.resourceType) ?? new Set<string>();
    bucket.add(row.resourceId);
    byType.set(row.resourceType, bucket);
  }

  const names = new Map<string, string>();
  const key = (type: string, id: string) => `${type}:${id}`;

  await Promise.all(
    Array.from(byType.entries()).map(async ([type, idSet]) => {
      const ids = Array.from(idSet);
      try {
        switch (type) {
          case "project": {
            for (const r of await repos.project.listNamesByIds(ids)) names.set(key(type, r.id), r.name);
            break;
          }
          case "server": {
            for (const r of await repos.server.listNamesByIds(ids)) names.set(key(type, r.id), r.name);
            break;
          }
          case "service": {
            for (const r of await repos.service.listNamesByIds(ids)) names.set(key(type, r.id), r.name);
            break;
          }
          case "domain": {
            for (const r of await repos.domain.listByIds(ids)) names.set(key(type, r.id), r.hostname);
            break;
          }
          case "job": {
            for (const r of await repos.job.listNamesByIds(ids)) names.set(key(type, r.id), r.name);
            break;
          }
          default:
            break;
        }
      } catch (err) {
        console.warn(`[audit] could not resolve ${type} names`, err);
      }
    }),
  );

  return names;
}

r.get("/", { tag: "audit:read" }, async (c: Context) => {
  const ctx = getRequestContext(c);
  const cursor = c.req.query("cursor");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Math.min(Number(c.req.query("perPage") ?? 50), 200);
  const filters = await filtersFromQuery(c, ctx.organizationId);

  // Cursor mode is recommended for any consumer that streams pages —
  // it survives concurrent writes (no shifted rows). Page/perPage is
  // the dashboard's "Showing N of M" fallback.
  const result =
    cursor !== undefined
      ? await repos.auditEvent.listByOrganization(ctx.organizationId, { ...filters, cursor, limit })
      : await repos.auditEvent.listByOrganization(ctx.organizationId, { ...filters, page, perPage });

  // Enrich rows with actor (name/email) via a SINGLE batched user lookup.
  // Without this, the dashboard would either show raw actorUserId strings
  // or fan out one /api/user/:id per row — explicit N+1 we avoid here by
  // collecting the unique ids and joining client-side in a Map.
  const actorIds = Array.from(
    new Set(result.rows.map((r) => r.actorUserId).filter((id): id is string => !!id)),
  );
  const [actors, resourceNames] = await Promise.all([
    repos.user.findManyByIds(actorIds),
    attachResourceNames(result.rows),
  ]);
  const actorById = new Map(actors.map((u) => [u.id, { id: u.id, email: u.email, name: u.name }]));

  const enrichedRows = result.rows.map((row) => ({
    ...row,
    actor: row.actorUserId ? actorById.get(row.actorUserId) ?? null : null,
    resourceName:
      row.resourceType && row.resourceId
        ? resourceNames.get(`${row.resourceType}:${row.resourceId}`) ?? null
        : null,
  }));

  if ("pageInfo" in result) {
    return c.json({ data: enrichedRows, pageInfo: result.pageInfo });
  }
  return c.json({
    data: enrichedRows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
});

/**
 * Everything the filter bar needs, in one request.
 *
 * Each facet is counted with the OTHER filters applied but not its own —
 * otherwise selecting "MCP" would show every other source as 0 and the user
 * could never leave the choice they just made.
 */
r.get("/facets", { tag: "audit:read" }, async (c: Context) => {
  const ctx = getRequestContext(c);
  const orgId = ctx.organizationId;
  const filters = await filtersFromQuery(c, orgId);
  const { eventTypes, source, ...shared } = filters;

  const [byEventType, bySource, actorIds, settings, canManage] = await Promise.all([
    repos.auditEvent.countByEventType(orgId, { ...shared, source }),
    repos.auditEvent.countBySource(orgId, { ...shared, eventTypes }),
    repos.auditEvent.distinctActors(orgId, { from: filters.from, to: filters.to }),
    repos.auditSettings.get(orgId),
    checkPermissionOnResource(ctx, { resourceType: "audit", resourceId: "*", action: "write" }),
  ]);

  const categoryCounts = new Map<string, number>(AUDIT_CATEGORIES.map((cat) => [cat.id, 0]));
  let total = 0;
  // Event types with no catalog entry (a new emitter, an old row) are counted in
  // the total but in no tab, so "All" always adds up to at least the tabs.
  for (const { eventType, count } of byEventType) {
    total += count;
    const category = categoryForAuditEvent(eventType);
    if (category) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + count);
  }

  const actors = await repos.user.findManyByIds(actorIds);

  return c.json({
    total,
    categories: AUDIT_CATEGORIES.map((cat) => ({
      id: cat.id,
      label: cat.label,
      description: cat.description,
      count: categoryCounts.get(cat.id) ?? 0,
    })),
    sources: bySource.map((row) => ({ source: row.source, count: row.count })),
    actors: actors.map((u) => ({ id: u.id, name: u.name, email: u.email, image: u.image })),
    settings,
    canManage,
  });
});

r.get("/settings", { tag: "audit:read" }, async (c: Context) => {
  const ctx = getRequestContext(c);
  const settings = await repos.auditSettings.get(ctx.organizationId);
  const canManage = await checkPermissionOnResource(ctx, {
    resourceType: "audit",
    resourceId: "*",
    action: "write",
  });
  return c.json({ ...settings, canManage });
});

r.patch("/settings", { tag: "audit:write" }, async (c: Context) => {
  const ctx = getRequestContext(c);
  const orgId = ctx.organizationId;
  const body = await c.req.json().catch(() => ({}));

  const patch: { enabled?: boolean; retentionDays?: number } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.retentionDays !== undefined) {
    const days = Number(body.retentionDays);
    if (!RETENTION_CHOICES.includes(days as (typeof RETENTION_CHOICES)[number])) {
      return c.json({ error: `retentionDays must be one of ${RETENTION_CHOICES.join(", ")}` }, 400);
    }
    patch.retentionDays = days;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update" }, 400);

  const current = await repos.auditSettings.get(orgId);
  const auditCtx = auditContextFrom(c, orgId, ctx.userId);
  const turningOff = patch.enabled === false && current.enabled;
  const turningOn = patch.enabled === true && !current.enabled;
  const retentionChanged =
    patch.retentionDays !== undefined && patch.retentionDays !== current.retentionDays;

  const recordRetention = () =>
    audit.record(auditCtx, {
      eventType: "audit.retention_changed",
      resourceType: "audit",
      resourceId: "*",
      before: { retentionDays: current.retentionDays },
      after: { retentionDays: patch.retentionDays },
    });

  // Order matters. Recording is what we are switching off, so the rows describing
  // this change have to be written while it is still on — after the flip the
  // repo-level gate would drop them and the log would end with no explanation.
  // (This is also why the tag's auto-emitted `audit:write` row can't stand in for
  // these: requirePermission emits it after the handler, i.e. after the flip.)
  if (turningOff) {
    await audit.record(auditCtx, {
      eventType: "audit.disabled",
      resourceType: "audit",
      resourceId: "*",
      before: { enabled: true },
      after: { enabled: false },
    });
  }
  if (retentionChanged && current.enabled) await recordRetention();

  const settings = await repos.auditSettings.upsert(orgId, patch);

  if (turningOn) {
    await audit.record(auditCtx, {
      eventType: "audit.enabled",
      resourceType: "audit",
      resourceId: "*",
      before: { enabled: false },
      after: { enabled: true },
    });
  }
  // Recording was off before this request: the row is only writable now, and only
  // if this same patch turned it back on.
  if (retentionChanged && !current.enabled) await recordRetention();

  return c.json({ ...settings, canManage: true });
});

export const auditRoutes = r.hono;
