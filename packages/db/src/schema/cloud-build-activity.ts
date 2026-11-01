import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ManagedCommandRef } from "@repo/core";
import { cloudWorkspace } from "./cloud-workspace";

/** Non-expiring shared admission. Finished rows prevent late duplicate execution. */
export const cloudBuildActivity = pgTable(
  "cloud_build_activity",
  {
    deploymentId: text("deployment_id").primaryKey(),
    projectId: text("project_id").notNull(),
    buildSessionId: text("build_session_id"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cloudWorkspace.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    providerWorkspaceId: text("provider_workspace_id"),
    ownerToken: text("owner_token"),
    resources: jsonb("resources").$type<{ cpuCores: number; memoryMb: number }>(),
    exclusivePreparation: boolean("exclusive_preparation").notNull().default(false),
    reservedAt: timestamp("reserved_at").notNull().defaultNow(),
    commands: jsonb("commands").$type<ManagedCommandRef[]>().notNull().default([]),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    slotReleasedAt: timestamp("slot_released_at"),
  },
  (table) => [
    index("cloud_build_activity_open_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.finishedAt} IS NULL`),
  ],
);

export type CloudBuildActivity = typeof cloudBuildActivity.$inferSelect;
