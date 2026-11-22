import { DEFAULT_GIT_PROVIDER } from "@repo/core";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── Cloud webhook bindings ────────────────────────────────────────────────────

/**
 * Routes a GitHub push received by a self-hosted box to a CLOUD project on the
 * SaaS. A project promoted local→cloud keeps its GitHub webhook pointing here
 * (teardown preserves it) but loses its local row + secret; this binding is what
 * survives, so a push can be hard-validated (webhookSecret) and forwarded to the
 * SaaS as the org owner. `cloudProjectId` is the SaaS project id, which equals
 * the original local `proj_` id (dump/ingest preserves it).
 */
export const cloudWebhookBinding = pgTable(
  "cloud_webhook_binding",
  {
    id: text("id").primaryKey(), // "cwb_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** SaaS project id (== the original local proj_ id). */
    cloudProjectId: text("cloud_project_id").notNull(),
    /** Stored lowercased to match project.repo.findByGitRepo's lower() compare. */
    gitProvider: text("git_provider").notNull().default(DEFAULT_GIT_PROVIDER),
    gitOwner: text("git_owner").notNull(),
    gitRepo: text("git_repo").notNull(),
    /** "" means "the repo's default branch". NOT NULL so the unique index below
     *  actually dedups (Postgres treats NULL as distinct → duplicate upserts). */
    gitBranch: text("git_branch").notNull().default(""),
    /** GitHub webhook id (null for enumeration-healed, routing-only bindings). */
    webhookId: text("webhook_id"),
    /** Opaque ciphertext, same scheme as project.webhookSecret (copied verbatim).
     *  Null for routing-only bindings (secret lost / self-healed). */
    webhookSecret: text("webhook_secret"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_cloud_webhook_binding_repo_branch").on(
      t.organizationId,
      t.gitProvider,
      t.gitOwner,
      t.gitRepo,
      t.gitBranch,
    ),
    index("idx_cloud_webhook_binding_cloud_project").on(t.cloudProjectId),
  ],
);
