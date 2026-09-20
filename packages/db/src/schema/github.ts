import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";
import { gitSource } from "./git-source";

// ─── GitHub App installation tracking ────────────────────────────────────────

/**
 * Tracks GitHub App installations per Openship organization.
 * `userId` records the user who connected/last reconciled the installation;
 * authorization and token resolution are always scoped by `organizationId`.
 */
export const gitInstallation = pgTable(
  "git_installation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Org that owns this installation. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Null only for the legacy env/Cloud/OAuth installation paths. */
    sourceId: text("source_id").references(() => gitSource.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    installationId: integer("installation_id").notNull(),
    owner: text("owner").notNull(),
    ownerType: text("owner_type").notNull().default("User"),
    providerUserId: text("provider_user_id"),
    providerOwnerId: text("provider_owner_id"),
    isOrg: boolean("is_org").notNull().default(false),
    /** Retained across a reversible GitHub suspension, but excluded from mint/list lookups. */
    suspendedAt: timestamp("suspended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One installation row per GitHub owner in each Openship workspace.
    // Including organizationId is load-bearing: one user may connect the
    // same GitHub organization to multiple Openship workspaces, while one
    // workspace must never inherit another workspace's installation row.
    uniqueIndex("uq_git_installation_provider_owner_org_legacy")
      .on(t.provider, t.owner, t.organizationId)
      .where(sql`${t.sourceId} IS NULL`),
    // The same GitHub owner may be connected through several independently
    // registered Apps. Within one source it still has exactly one installation.
    uniqueIndex("uq_git_installation_provider_owner_org_source")
      .on(t.provider, t.owner, t.organizationId, t.sourceId)
      .where(sql`${t.sourceId} IS NOT NULL`),
    // Member-onboarding + org-scoped App resolution: every authed
    // request that mints an installation token via the org path hits
    // this. Without it, the table is full-scanned per lookup.
    index("idx_git_installation_org").on(t.organizationId, t.provider, t.owner),
    index("idx_git_installation_source").on(t.sourceId, t.installationId),
  ],
);
