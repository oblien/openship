/**
 * Audit event repo — append-only writes, paginated reads.
 *
 * Writes are typically async (via job-runner) for non-critical events so
 * mutations don't block on the audit insert. Reads power the /audit feed
 * + per-resource Activity tabs.
 */

import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { auditEvent } from "../schema/audit-event";
import { user } from "../schema/auth";

export type AuditEvent = typeof auditEvent.$inferSelect;
export type NewAuditEvent = typeof auditEvent.$inferInsert;

/**
 * Opaque cursor for keyset pagination. base64url-encoded JSON of
 * `{ts, id}` from the boundary row — using id as the secondary sort
 * key disambiguates rows with the same createdAt timestamp.
 */
export interface AuditEventCursor {
  ts: string; // ISO timestamp
  id: string;
}

function encodeAuditCursor(row: AuditEvent): string {
  const cursor: AuditEventCursor = { ts: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeAuditCursor(raw: string): AuditEventCursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as AuditEventCursor;
    if (typeof parsed.ts !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Filters shared by the list, count-by-type and total queries. */
export interface AuditEventFilters {
  eventType?: string;
  /** Match any of these types — how a UI category expands to its members. */
  eventTypes?: string[];
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Call surface: "dashboard" | "mcp" | "cli" | "api" | "webhook" | "system". */
  source?: string;
  from?: Date;
  to?: Date;
  /** Free text over event type, resource id/name and actor name/email. */
  q?: string;
  /** Extra resource ids to match on (org resources whose NAME matched `q`). */
  qResourceIds?: string[];
}

/** Minimum the repo needs from the settings repo — keeps the two decoupled. */
interface AuditRecordingSwitch {
  isEnabled(organizationId: string): Promise<boolean>;
}

export function createAuditEventRepo(db: Database, settings?: AuditRecordingSwitch) {
  function buildFilters(organizationId: string, f?: AuditEventFilters) {
    const filters = [eq(auditEvent.organizationId, organizationId)];
    if (f?.eventType) filters.push(eq(auditEvent.eventType, f.eventType));
    if (f?.eventTypes?.length) filters.push(inArray(auditEvent.eventType, f.eventTypes));
    if (f?.actorUserId) filters.push(eq(auditEvent.actorUserId, f.actorUserId));
    if (f?.resourceType) filters.push(eq(auditEvent.resourceType, f.resourceType));
    if (f?.resourceId) filters.push(eq(auditEvent.resourceId, f.resourceId));
    if (f?.source) filters.push(eq(auditEvent.source, f.source));
    if (f?.from) filters.push(gte(auditEvent.createdAt, f.from));
    if (f?.to) filters.push(lte(auditEvent.createdAt, f.to));
    if (f?.q) {
      const pattern = `%${f.q}%`;
      const clauses = [
        ilike(auditEvent.eventType, pattern),
        ilike(auditEvent.resourceId, pattern),
        // Actor by name/email. A subquery rather than a join so the shape of the
        // select (and the count query below) stays a plain audit_event row.
        sql`${auditEvent.actorUserId} IN (SELECT ${user.id} FROM ${user} WHERE ${user.name} ILIKE ${pattern} OR ${user.email} ILIKE ${pattern})`,
      ];
      // Resources the caller resolved by name — lets "api-gateway" match rows
      // that only ever stored prj_xxx.
      if (f.qResourceIds?.length) clauses.push(inArray(auditEvent.resourceId, f.qResourceIds));
      const search = or(...clauses);
      if (search) filters.push(search);
    }
    return filters;
  }

  return {
    /**
     * Append one event.
     *
     * Returns null when the org has audit recording switched off. The gate lives
     * here rather than in the API's audit helper because several services insert
     * through this repo directly (cloud-session, cloud-github, incident,
     * billing-anniversary) — this is the one path all of them share.
     */
    async create(data: Omit<NewAuditEvent, "id" | "createdAt">): Promise<AuditEvent | null> {
      if (settings && !(await settings.isEnabled(data.organizationId))) return null;
      const id = generateId("aud");
      const row: NewAuditEvent = { id, ...data };
      await db.insert(auditEvent).values(row);
      return { ...row, createdAt: new Date() } as AuditEvent;
    },

    /**
     * List events for an org with optional filters.
     *
     * Two pagination modes — pass ONE:
     *
     *   `cursor`           Keyset pagination. Safe under concurrent
     *                      writes (the canonical mode for audit_event
     *                      which only ever grows). Returns
     *                      `pageInfo.endCursor` to fetch the next page.
     *                      No `total` (counting an indefinite stream
     *                      is wasteful + meaningless).
     *
     *   `page` + `perPage` Offset pagination. Compatible with the
     *                      existing /api/audit "Showing 1-50 of N"
     *                      dashboard UI. May show duplicates under
     *                      heavy concurrent writes — accept the
     *                      tradeoff or migrate the caller to cursor.
     *
     * Default: newest first. Filters compose with both modes.
     */
    async listByOrganization(
      organizationId: string,
      opts?: AuditEventFilters & {
        cursor?: string;
        limit?: number;
        page?: number;
        perPage?: number;
      },
    ) {
      const filters = buildFilters(organizationId, opts);

      // Cursor mode: keyset pagination on (createdAt, id) DESC.
      if (opts?.cursor !== undefined) {
        const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
        const decoded = decodeAuditCursor(opts.cursor);
        if (decoded) {
          // Boundary: rows strictly older than (decoded.ts, decoded.id).
          // Two-key tuple comparison: createdAt < ts, OR (createdAt = ts AND id < id).
          const boundary = or(
            lt(auditEvent.createdAt, new Date(decoded.ts)),
            and(
              eq(auditEvent.createdAt, new Date(decoded.ts)),
              lt(auditEvent.id, decoded.id),
            ),
          );
          if (boundary) filters.push(boundary);
        }
        const where = filters.length === 1 ? filters[0] : and(...filters);
        // Fetch limit+1 to detect hasNextPage without a count query.
        const rows = await db
          .select()
          .from(auditEvent)
          .where(where)
          .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
          .limit(limit + 1);
        const hasNextPage = rows.length > limit;
        const trimmed = hasNextPage ? rows.slice(0, limit) : rows;
        const endCursor = trimmed.length > 0
          ? encodeAuditCursor(trimmed[trimmed.length - 1])
          : undefined;
        return {
          rows: trimmed,
          pageInfo: { hasNextPage, endCursor },
        };
      }

      // Offset mode.
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 50;
      const offset = (page - 1) * perPage;
      const where = filters.length === 1 ? filters[0] : and(...filters);
      const rows = await db
        .select()
        .from(auditEvent)
        .where(where)
        // id as tiebreaker: without it, rows sharing a createdAt can reshuffle
        // between pages and appear twice (or not at all) while paging.
        .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
        .limit(perPage)
        .offset(offset);

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(auditEvent)
        .where(where);

      return { rows, total: Number(total), page, perPage };
    },

    /**
     * Row count per event type under the given filters. The audit UI folds these
     * through the shared taxonomy to get per-category tab counts — one query
     * instead of one per category.
     */
    async countByEventType(
      organizationId: string,
      filters?: AuditEventFilters,
    ): Promise<{ eventType: string; count: number }[]> {
      const where = and(...buildFilters(organizationId, filters));
      const rows = await db
        .select({ eventType: auditEvent.eventType, count: sql<number>`count(*)` })
        .from(auditEvent)
        .where(where)
        .groupBy(auditEvent.eventType);
      return rows.map((r) => ({ eventType: r.eventType, count: Number(r.count) }));
    },

    /** Row count per call source under the given filters (null → "unknown"). */
    async countBySource(
      organizationId: string,
      filters?: AuditEventFilters,
    ): Promise<{ source: string | null; count: number }[]> {
      const where = and(...buildFilters(organizationId, filters));
      const rows = await db
        .select({ source: auditEvent.source, count: sql<number>`count(*)` })
        .from(auditEvent)
        .where(where)
        .groupBy(auditEvent.source);
      return rows.map((r) => ({ source: r.source, count: Number(r.count) }));
    },

    /**
     * Distinct actor ids that appear in the window — the option list for the
     * "who did this" filter. Bounded by the window (and by `limit`) so this
     * never degenerates into a scan of the whole table; org+actor is indexed.
     */
    async distinctActors(
      organizationId: string,
      opts?: { from?: Date; to?: Date; limit?: number },
    ): Promise<string[]> {
      const rows = await db
        .selectDistinct({ actorUserId: auditEvent.actorUserId })
        .from(auditEvent)
        .where(and(...buildFilters(organizationId, { from: opts?.from, to: opts?.to })))
        .limit(Math.min(opts?.limit ?? 200, 500));
      return rows.map((r) => r.actorUserId).filter((id): id is string => Boolean(id));
    },

    /**
     * Delete events older than the cutoff. Used by the retention prune
     * job. Returns the number of rows deleted (best-effort — Postgres
     * adapters don't all surface a count, so callers shouldn't rely on
     * exact numbers for billing).
     */
    async pruneOlderThan(organizationId: string, cutoff: Date): Promise<void> {
      await db
        .delete(auditEvent)
        .where(and(eq(auditEvent.organizationId, organizationId), lt(auditEvent.createdAt, cutoff)));
    },
  };
}
