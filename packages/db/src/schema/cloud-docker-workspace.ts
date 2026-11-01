import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { cloudWorkspace } from "./cloud-workspace";

/** One persistent provider server for each subscribed workspace. */
export const cloudDockerWorkspace = pgTable("cloud_docker_workspace", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  ownerWorkspaceId: text("owner_workspace_id").notNull().references(() => cloudWorkspace.id, { onDelete: "restrict" }),
  namespace: text("namespace").notNull(),
  provisionKey: text("provision_key").notNull(),
  workspaceId: text("workspace_id"),
  image: text("image").notNull(),
  resources: jsonb("resources").$type<{ cpuCores: number; memoryMb: number; diskMb: number }>().notNull(),
  state: text("state").$type<"provisioning" | "ready">().notNull().default("provisioning"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, table => [
  uniqueIndex("uq_cloud_docker_workspace_owner").on(table.ownerWorkspaceId),
  uniqueIndex("uq_cloud_docker_workspace_id").on(table.workspaceId),
  uniqueIndex("uq_cloud_docker_provision_key").on(table.provisionKey),
]);
