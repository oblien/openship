/** Retained audit filtering, presentation, and recording controls. */
import { repos } from "@repo/db";
import { AUDIT_CATEGORIES, categoryForAuditEvent, eventTypesForCategory, isAuditCategoryId } from "@repo/core";
import { ValidationError, AuditSettingsInput, type AuditQuery } from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import type { ExecutionContext } from "../../../context";
import { checkPermissionOnResource } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { isAuditClientId, isAuditSource } from "../../lib/operation-source";
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
async function filtersFromQuery(input: AuditQuery, organizationId: string) {
  const category = input.category;
  const eventType = input.eventType;
  const source = input.source;
  const sourceClientId = input.sourceClientId;
  const q = input.q?.trim();

  return {
    eventType: eventType || undefined,
    // An unknown category yields an empty list, which the repo ignores — the
    // request degrades to unfiltered rather than 400-ing on a stale bookmark.
    eventTypes:
      category && category !== "all" && isAuditCategoryId(category)
        ? eventTypesForCategory(category)
        : undefined,
    actorUserId: input.actorUserId || undefined,
    resourceType: input.resourceType || undefined,
    resourceId: input.resourceId || undefined,
    source: source && isAuditSource(source) ? source : undefined,
    // Shape-checked with the same predicate the writer uses, so a filter can only
    // name something the column could hold. A malformed value degrades to
    // unfiltered, matching how an unknown category behaves above.
    sourceClientId: isAuditClientId(sourceClientId) ? sourceClientId : undefined,
    from: parseDate(input.from),
    to: parseDate(input.to),
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

/**
 * Names for `source_client_id` values — `oauth:<clientId>` → the registered MCP
 * app's name, `pat:<tokenId>` → the token's name.
 *
 * Two batched lookups at most, in parallel, same as the resource resolver above.
 * An unresolvable id (client deleted, token revoked and pruned) stays nameless
 * and the UI falls back to the raw id: a row attributed to something that no
 * longer exists is still evidence, and dropping it would be worse.
 */
async function resolveClientNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;

  const oauthIds: string[] = [];
  const patIds: string[] = [];
  for (const id of ids) {
    if (id.startsWith("oauth:")) oauthIds.push(id.slice("oauth:".length));
    else if (id.startsWith("pat:")) patIds.push(id.slice("pat:".length));
  }

  const [apps, tokens] = await Promise.all([
    oauthIds.length ? repos.oauth.listApplicationsByClientIds(oauthIds).catch(() => []) : [],
    patIds.length ? repos.personalAccessToken.listNamesByIds(patIds).catch(() => []) : [],
  ]);
  for (const a of apps) names.set(`oauth:${a.clientId}`, a.name);
  for (const t of tokens) names.set(`pat:${t.id}`, t.name);
  return names;
}

export async function list(ctx: ExecutionContext, input: AuditQuery = {}) {
  const cursor = input.cursor;
  const limit = Math.min(Number(input.limit ?? 50), 200);
  const page = Number(input.page ?? 1);
  const perPage = Math.min(Number(input.perPage ?? 50), 200);
  const filters = await filtersFromQuery(input, ctx.organizationId);

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
  const clientIds = Array.from(
    new Set(result.rows.map((r) => r.sourceClientId).filter((id): id is string => !!id)),
  );
  const [actors, resourceNames, clientNames] = await Promise.all([
    repos.user.findManyByIds(actorIds),
    attachResourceNames(result.rows),
    resolveClientNames(clientIds),
  ]);
  const actorById = new Map(actors.map((u) => [u.id, { id: u.id, email: u.email, name: u.name }]));

  const enrichedRows = result.rows.map((row) => ({
    ...row,
    actor: row.actorUserId ? actorById.get(row.actorUserId) ?? null : null,
    resourceName:
      row.resourceType && row.resourceId
        ? resourceNames.get(`${row.resourceType}:${row.resourceId}`) ?? null
        : null,
    // "Claude Desktop", not "oauth:4f2a…" — the actor a reader cares about when
    // the human in the row only authorized the agent months ago.
    sourceClientName: row.sourceClientId ? clientNames.get(row.sourceClientId) ?? null : null,
  }));

  if ("pageInfo" in result) {
    return ({ items: enrichedRows, pageInfo: result.pageInfo });
  }
  return ({
    items: enrichedRows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

export async function facets(ctx: ExecutionContext, input: AuditQuery = {}) {
  const orgId = ctx.organizationId;
  const filters = await filtersFromQuery(input, orgId);
  const { eventTypes, source, sourceClientId, ...shared } = filters;

  const [byEventType, bySource, byClient, actorIds, settings, canManage] = await Promise.all([
    repos.auditEvent.countByEventType(orgId, { ...shared, source, sourceClientId }),
    repos.auditEvent.countBySource(orgId, { ...shared, eventTypes, sourceClientId }),
    // Counted without its own filter, like every other facet — picking one agent
    // must not zero out the others and trap the filter on that choice.
    repos.auditEvent.countBySourceClient(orgId, { ...shared, eventTypes, source }),
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

  const [actors, clientNames] = await Promise.all([
    repos.user.findManyByIds(actorIds),
    resolveClientNames(byClient.map((row) => row.sourceClientId)),
  ]);

  return ({
    total,
    categories: AUDIT_CATEGORIES.map((cat) => ({
      id: cat.id,
      label: cat.label,
      description: cat.description,
      count: categoryCounts.get(cat.id) ?? 0,
    })),
    sources: bySource.map((row) => ({ source: row.source, count: row.count })),
    clients: byClient.map((row) => ({
      id: row.sourceClientId,
      name: clientNames.get(row.sourceClientId) ?? null,
      count: row.count,
    })),
    actors: actors.map((u) => ({ id: u.id, name: u.name, email: u.email, image: u.image })),
    settings,
    canManage,
  });
}

export async function getSettings(ctx: ExecutionContext) {
  const settings = await repos.auditSettings.get(ctx.organizationId);
  const canManage = await checkPermissionOnResource(ctx, {
    resourceType: "audit",
    resourceId: "*",
    action: "write",
  });
  return ({ ...settings, canManage });
}

export async function updateSettings(ctx: ExecutionContext, body: Static<typeof AuditSettingsInput>) {
  const orgId = ctx.organizationId;

  const patch: { enabled?: boolean; retentionDays?: number } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.retentionDays !== undefined) {
    const days = Number(body.retentionDays);
    if (!RETENTION_CHOICES.includes(days as (typeof RETENTION_CHOICES)[number])) {
      throw new ValidationError(`retentionDays must be one of ${RETENTION_CHOICES.join(", ")}`);
    }
    patch.retentionDays = days;
  }
  if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to update");

  const current = await repos.auditSettings.get(orgId);
  const auditCtx = operationAuditContext(ctx);
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

  return ({ ...settings, canManage: true });
}
