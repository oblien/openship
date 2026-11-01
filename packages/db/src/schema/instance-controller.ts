import { check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ControllerRole, HandoffManifest } from "@repo/core";

export interface InstanceProvisioning {
  organizationId: string;
  serverId: string;
  access: "desktop" | "browser";
  domain: { kind: "custom" | "free"; hostname: string };
  version: string;
  projectId?: string;
  deploymentId?: string;
}

/** Installation-local authority, deliberately excluded from database transfers.
 * Restoring the source's active flag at the destination would start two writers. */
export const instanceController = pgTable(
  "instance_controller",
  {
    id: text("id").primaryKey().default("local"),
    installationId: text("installation_id").notNull().unique(),
    role: text("role").$type<ControllerRole>().notNull().default("active"),
    handoffId: text("handoff_id"),
    revision: integer("revision").notNull().default(0),
    connection: text("connection"), // encrypted device connection, never exported
    environment: text("environment"), // resealed portable integration configuration
    desktopUserId: text("desktop_user_id"), // trusted local device identity; never exported
    projectId: text("project_id"), // this installation's hosted API, never exported
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("instance_controller_singleton", sql`${t.id} = 'local'`),
    check(
      "instance_controller_role",
      sql`${t.role} IN ('active','quiescing','frozen','receiving','prepared','retired','connected')`,
    ),
  ],
);

export const instanceHandoff = pgTable(
  "instance_handoff",
  {
    id: text("id").primaryKey(),
    direction: text("direction").$type<"source" | "target">().notNull(),
    ownerUserId: text("owner_user_id").notNull(), // no FK: identities are restored
    tokenHash: text("token_hash").notNull(),
    secrets: text("secrets").notNull(), // instance-encrypted transfer key + retirement proof
    status: text("status")
      .$type<"offered" | "frozen" | "copying" | "prepared" | "retired" | "complete" | "aborted">()
      .notNull()
      .default("offered"),
    manifest: jsonb("manifest").$type<HandoffManifest>(),
    recovery:
      jsonb("recovery").$type<Pick<HandoffManifest, "totalBytes" | "totalChunks" | "sha256">>(),
    provisioning: jsonb("provisioning").$type<InstanceProvisioning>(),
    peerOrigin: text("peer_origin"),
    peerId: text("peer_id"),
    result: text("result"), // encrypted connection, for idempotent activation
    error: text("error"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("instance_handoff_direction", sql`${t.direction} IN ('source','target')`),
    check(
      "instance_handoff_status",
      sql`${t.status} IN ('offered','frozen','copying','prepared','retired','complete','aborted')`,
    ),
  ],
);
