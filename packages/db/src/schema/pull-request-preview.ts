import { pgTable, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { project } from "./project";
import { organization } from "./organization";

/** Desired PR state is reconciled against GitHub, including after missed/duplicate deliveries. */
export const pullRequestPreview = pgTable(
  "pull_request_preview",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Deliberately retained after the source project is removed so its previews can be cleaned up.
    sourceProjectId: text("source_project_id").notNull(),
    projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    headSha: text("head_sha"),
    deploymentId: text("deployment_id"),
    status: text("status").notNull().default("pending"),
    url: text("url"),
    commentId: text("comment_id"),
    publishedDigest: text("published_digest"),
    error: text("error"),
    nextAttemptAt: timestamp("next_attempt_at").defaultNow(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pull_request_preview_source_repository_number").on(
      table.sourceProjectId,
      table.owner,
      table.repo,
      table.number,
    ),
    index("pull_request_preview_due").on(table.nextAttemptAt),
  ],
);
