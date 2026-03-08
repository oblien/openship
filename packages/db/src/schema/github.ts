import { pgTable, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { user } from "./auth";

// ─── GitHub App installation tracking ────────────────────────────────────────

/**
 * Tracks GitHub App installations per user.
 * Each row represents one installation (user or org account).
 */
export const gitInstallation = pgTable("git_installation", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("github"), // future: gitlab, bitbucket
  installationId: integer("installation_id").notNull(),
  owner: text("owner").notNull(), // GitHub account login (user or org)
  ownerType: text("owner_type").notNull().default("User"), // "User" | "Organization"
  providerUserId: text("provider_user_id"), // GitHub sender.id
  providerOwnerId: text("provider_owner_id"), // GitHub account.id
  isOrg: boolean("is_org").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
