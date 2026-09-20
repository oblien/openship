import { pgTable, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { project } from "./project";

/** One durable Docker host for a deployable project environment, never a release. */
export const cloudDockerWorkspace = pgTable("cloud_docker_workspace", {
  projectId: text("project_id").primaryKey().references(() => project.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  provisionKey: text("provision_key").notNull(),
  workspaceId: text("workspace_id"),
  image: text("image").notNull(),
  resources: jsonb("resources").$type<{ cpuCores: number; memoryMb: number; diskMb: number }>().notNull(),
  state: text("state").$type<"provisioning" | "ready">().notNull().default("provisioning"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, table => [
  uniqueIndex("uq_cloud_docker_workspace_id").on(table.workspaceId),
  uniqueIndex("uq_cloud_docker_provision_key").on(table.provisionKey),
]);
