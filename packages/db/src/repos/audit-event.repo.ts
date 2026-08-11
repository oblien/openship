/**
 * Audit event repo — append-only writes, paginated reads.
 *
 * Writes are typically async (via job-runner) for non-critical events so
 * mutations don't block on the audit insert. Reads power the /audit feed
 * + per-resource Activity tabs.
 */

import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { auditEvent } from "../schema/audit-event";

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

export function createAuditEventRepo(db: Database) {
  return {
    async create(data: Omit<NewAuditEvent, "id" | "createdAt">): Promise<AuditEvent> {
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
      opts?: {
        cursor?: string;
        limit?: number;
        page?: number;
        perPage?: number;
        eventType?: string;
        actorUserId?: string;
        resourceType?: string;
        resourceId?: string;
      },
    ) {
      const filters = [eq(auditEvent.organizationId, organizationId)];
      if (opts?.eventType) filters.push(eq(auditEvent.eventType, opts.eventType));
      if (opts?.actorUserId) filters.push(eq(auditEvent.actorUserId, opts.actorUserId));
      if (opts?.resourceType) filters.push(eq(auditEvent.resourceType, opts.resourceType));
      if (opts?.resourceId) filters.push(eq(auditEvent.resourceId, opts.resourceId));

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
        .orderBy(desc(auditEvent.createdAt))
        .limit(perPage)
        .offset(offset);

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(auditEvent)
        .where(where);

      return { rows, total: Number(total), page, perPage };
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
