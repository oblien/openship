import { and, desc, eq, lt, or } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { webhookDelivery } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WebhookDelivery = typeof webhookDelivery.$inferSelect;
export type NewWebhookDelivery = typeof webhookDelivery.$inferInsert;

/** Fields a caller supplies to record/claim a delivery (id + timestamps are set here). */
export type WebhookDeliveryInput = Omit<NewWebhookDelivery, "id" | "receivedAt" | "processedAt">;

/** Patch applied when a delivery finishes handling. */
export interface WebhookDeliveryResult {
  outcome: string;
  actionRef?: string | null;
  statusCode?: number | null;
  error?: string | null;
  summary?: unknown;
  durationMs?: number | null;
}

export interface Page<T> {
  rows: T[];
  /** Opaque cursor for the next page; undefined when there are no more rows. */
  nextCursor?: string;
}

const encodeCursor = (r: { receivedAt: Date; id: string }) => `${r.receivedAt.toISOString()}|${r.id}`;
function decodeCursor(cursor?: string): { at: Date; id: string } | null {
  if (!cursor) return null;
  const i = cursor.lastIndexOf("|");
  if (i < 0) return null;
  const at = new Date(cursor.slice(0, i));
  return Number.isNaN(at.getTime()) ? null : { at, id: cursor.slice(i + 1) };
}
const clampLimit = (n?: number) => Math.min(Math.max(n ?? 25, 1), 100);

// ─── Repository ──────────────────────────────────────────────────────────────

export function createWebhookDeliveryRepo(db: Database) {
  /** Keyset page over `receivedAt desc, id desc` under a base filter. */
  async function page(base: ReturnType<typeof and>, opts?: { cursor?: string; limit?: number }): Promise<Page<WebhookDelivery>> {
    const limit = clampLimit(opts?.limit);
    const cur = decodeCursor(opts?.cursor);
    const where = cur
      ? and(
          base,
          or(
            lt(webhookDelivery.receivedAt, cur.at),
            and(eq(webhookDelivery.receivedAt, cur.at), lt(webhookDelivery.id, cur.id)),
          ),
        )
      : base;
    const rows = await db
      .select()
      .from(webhookDelivery)
      .where(where)
      .orderBy(desc(webhookDelivery.receivedAt), desc(webhookDelivery.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return { rows: pageRows, nextCursor: hasMore && last ? encodeCursor(last) : undefined };
  }

  return {
    /**
     * Atomically CLAIM a GitHub delivery id (source='github'). Returns
     * claimed:true + the new row id on the FIRST delivery; claimed:false on a
     * redelivery (partial-unique conflict) so the handler drops it. This is the
     * idempotency guard formerly in github_webhook_event.claim.
     */
    async claimGithub(input: Omit<WebhookDeliveryInput, "source">): Promise<{ claimed: boolean; id: string }> {
      const id = generateId("wdl");
      const rows = await db
        .insert(webhookDelivery)
        .values({ ...input, id, source: "github" })
        .onConflictDoNothing()
        .returning();
      return rows.length > 0 ? { claimed: true, id } : { claimed: false, id: "" };
    },

    /** Record a delivery row (incoming/backup, or a github fan-out row). Returns its id. */
    async record(input: WebhookDeliveryInput): Promise<string> {
      const id = generateId("wdl");
      await db.insert(webhookDelivery).values({ ...input, id });
      return id;
    },

    /** Stamp a delivery as handled (best-effort observability). */
    async markProcessed(id: string, result: WebhookDeliveryResult): Promise<void> {
      await db
        .update(webhookDelivery)
        .set({
          outcome: result.outcome,
          actionRef: result.actionRef ?? undefined,
          statusCode: result.statusCode ?? undefined,
          error: result.error ?? undefined,
          summary: result.summary ?? undefined,
          durationMs: result.durationMs ?? undefined,
          processedAt: new Date(),
        })
        .where(eq(webhookDelivery.id, id));
    },

    listByProject(projectId: string, opts?: { cursor?: string; limit?: number }) {
      return page(and(eq(webhookDelivery.projectId, projectId)), opts);
    },

    listByHook(hookId: string, opts?: { cursor?: string; limit?: number }) {
      return page(and(eq(webhookDelivery.hookId, hookId)), opts);
    },

    /** Org-wide feed — includes project-less forwarded/ignored rows for the org. */
    listByOrg(organizationId: string, opts?: { cursor?: string; limit?: number }) {
      return page(and(eq(webhookDelivery.organizationId, organizationId)), opts);
    },

    /** Delete rows older than `cutoff` (retention). Returns rows deleted. */
    async pruneOlderThan(cutoff: Date): Promise<number> {
      const rows = await db
        .delete(webhookDelivery)
        .where(lt(webhookDelivery.receivedAt, cutoff))
        .returning();
      return rows.length;
    },
  };
}
