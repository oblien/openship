import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./organization";
import { project } from "./project";

// ─── webhook_delivery ─────────────────────────────────────────────────────────
//
// ONE table for inbound webhook history AND GitHub idempotency (replaces the
// dedup-only github_webhook_event). Every inbound delivery — a GitHub push, a
// custom incoming-webhook call, a backup trigger — records one row here for a
// paginated feed. For GitHub the row DOUBLES as the delivery-id dedup claim:
// the partial-unique index below makes `INSERT … ON CONFLICT DO NOTHING
// RETURNING` return a row only for the FIRST delivery, so a redelivery is
// dropped (no double-deploy). incoming/backup rows carry a null delivery_id (the
// index predicate excludes them) so each call is a distinct row — no dedup.
//
// projectId is null for forwarded-to-cloud / unmanaged-repo / fan-out-anchor
// rows; organizationId is null for unmanaged-repo deliveries. Feed = observability
// (complements, does not replace, the audit log). Pruned by receivedAt.
export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: text("id").primaryKey(), // "wdl_..."
    /** Owning org (null for an unmanaged-repo GitHub delivery). */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    /** Target project (null for forwarded/unmanaged/anchor rows). */
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    /** 'github' | 'incoming' | 'backup'. */
    source: text("source").notNull(),
    /** incoming_webhook.id for source='incoming'; null otherwise. */
    hookId: text("hook_id"),
    /** X-GitHub-Delivery (source='github' only) — the idempotency key. */
    deliveryId: text("delivery_id"),
    /** GitHub event ('push', 'installation', …) or the incoming action type. */
    event: text("event").notNull(),
    /** 'ok' | 'failed' | 'none' (credential check result). */
    authResult: text("auth_result"),
    /** 'received' | 'dispatched' | 'skipped' | 'forwarded' | 'ignored' | 'failed'. */
    outcome: text("outcome").notNull(),
    /** Resulting deployment / job-run id, when dispatched. */
    actionRef: text("action_ref"),
    statusCode: integer("status_code"),
    error: text("error"),
    /** Small envelope for the feed — {repo,branch,commit,services?}. NEVER the body/secrets. */
    summary: jsonb("summary"),
    clientIp: text("client_ip"),
    userAgent: text("user_agent"),
    durationMs: integer("duration_ms"),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
  },
  (t) => [
    // GitHub delivery-id dedup (the claim). Partial: only github rows with a
    // delivery id participate, so incoming/backup rows never conflict.
    uniqueIndex("uq_webhook_delivery_github_delivery")
      .on(t.source, t.deliveryId)
      .where(sql`${t.source} = 'github' AND ${t.deliveryId} IS NOT NULL`),
    // Feed lookups (keyset paginated on receivedAt desc, id desc).
    index("idx_webhook_delivery_project").on(t.projectId, t.receivedAt),
    index("idx_webhook_delivery_org").on(t.organizationId, t.receivedAt),
    index("idx_webhook_delivery_hook").on(t.hookId, t.receivedAt),
  ],
);
