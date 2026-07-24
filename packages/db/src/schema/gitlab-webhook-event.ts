import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ─── gitlab_webhook_event ─────────────────────────────────────────────────────
// Idempotency table for inbound GitLab webhooks. The PK IS the GitLab delivery
// id (X-Gitlab-Event-UUID), so an at-least-once redelivery hits a conflict and
// the handler short-circuits. Mirrors github_webhook_event.
export const gitlabWebhookEvent = pgTable("gitlab_webhook_event", {
  deliveryId: text("delivery_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
});
