import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { project } from "./project";

// ─── Incoming webhooks ───────────────────────────────────────────────────────

/**
 * A generic, per-PROJECT inbound webhook: a dynamic endpoint
 * (`POST /api/webhooks/incoming/:id`) that, when called, fires a pluggable
 * action (a deploy of the project / a service, or a Job run). Each hook carries
 * its own auth (opaque bearer token, HMAC signature, or open) — the token/HMAC
 * secret is stored ENCRYPTED at rest (registered in ENCRYPTED_COLUMNS, like the
 * per-project GitHub secret). Generalizes the backup token-trigger pattern
 * (`backups/triggers/webhook.ts`) into a first-class primitive.
 *
 * NOT to be confused with `webhook_source` (org-scoped, HMAC-only, domain-routed
 * "topics" with no action) — this table is project-scoped, multi-auth, and
 * dispatches an action.
 */

/** What a hook does when called. Extensible — add a variant + a dispatch case. */
export type IncomingWebhookActionType = "deploy" | "job";

/** Per-action config (jsonb). deploy: optional target service; job: the job key. */
export type IncomingWebhookActionConfig = {
  /** deploy: restrict the redeploy to this service (omit = whole project). */
  serviceId?: string;
  /** job: the `job.key` to run. */
  jobKey?: string;
};

/** How an incoming call authenticates. */
export type IncomingWebhookAuthMode = "token" | "hmac" | "none";

export const incomingWebhook = pgTable(
  "incoming_webhook",
  {
    id: text("id").primaryKey(), // "iwh_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),

    /** Pluggable action fired on call. */
    actionType: text("action_type").$type<IncomingWebhookActionType>().notNull(),
    actionConfig: jsonb("action_config")
      .$type<IncomingWebhookActionConfig>()
      .notNull()
      .default({}),

    /** Auth mode + the (encrypted) credential for that mode. */
    authMode: text("auth_mode").$type<IncomingWebhookAuthMode>().notNull().default("token"),
    /** ENCRYPTED bearer token (authMode="token"). */
    tokenEncrypted: text("token_encrypted"),
    /** ENCRYPTED HMAC-SHA256 signing secret (authMode="hmac"). */
    hmacSecretEncrypted: text("hmac_secret_encrypted"),

    createdBy: text("created_by"),
    lastFiredAt: timestamp("last_fired_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_incoming_webhook_project").on(t.projectId),
    index("idx_incoming_webhook_org").on(t.organizationId),
  ],
);
