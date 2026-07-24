import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── Webhook sources ─────────────────────────────────────────────────────────

/**
 * A user-configured inbound webhook SOURCE (Settings → Webhooks) — org-scoped.
 * Each row is a "topic": a kind (github / manual), a label, and an HMAC signing
 * secret stored ENCRYPTED at rest (like the per-project GitHub secret — see
 * ENCRYPTED_COLUMNS in dump.ts). The receiver (POST /api/webhooks/:provider)
 * resolves a source's DECRYPTED secret to verify signatures (fail-closed).
 *
 * A source's public receiver URL is a `domain` row pointing back at it
 * (`domain.webhookSourceId` + `ownerType='webhook'`) so it reuses the exact
 * free/custom-domain routing projects use; the binding lives on the domain side
 * (single source of truth, no back-reference here).
 */
export const webhookSource = pgTable("webhook_source", {
  id: text("id").primaryKey(), // "whs_..."
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** Source kind: "github" | "manual". */
  kind: text("kind").notNull(),
  /** Human-facing label / topic name shown in the UI. */
  label: text("label").notNull(),
  /** HMAC signing secret — ENCRYPTED at rest (registered in ENCRYPTED_COLUMNS). */
  secret: text("secret").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("idx_webhook_source_org").on(t.organizationId),
]);
