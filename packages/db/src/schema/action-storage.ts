import {
  bigint,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { backupDestination } from "./backup";
import { actionJob, actionRun } from "./actions";

/** Metadata only. Artifact/cache bytes stay in the selected storage adapter. */
export const actionStorageObject = pgTable(
  "action_storage_object",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    jobId: text("job_id").notNull(),
    destinationId: text("destination_id")
      .notNull()
      .references(() => backupDestination.id, { onDelete: "restrict" }),
    kind: text("kind").$type<"artifact" | "cache">().notNull(),
    repository: text("repository").notNull(),
    ref: text("ref").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull().default(""),
    key: text("key").notNull(),
    state: text("state")
      .$type<"pending" | "assembling" | "uploaded" | "complete" | "deleting">()
      .notNull()
      .default("pending"),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
    maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
    size: bigint("size", { mode: "number" }),
    sha256: text("sha256"),
    finalKey: text("final_key"),
    leaseUntil: timestamp("lease_until"),
    leaseOwner: text("lease_owner"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_storage_object_owner_unique").on(t.id, t.organizationId),
    foreignKey({
      columns: [t.runId, t.organizationId],
      foreignColumns: [actionRun.id, actionRun.organizationId],
      name: "action_storage_run_owner_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.jobId, t.organizationId],
      foreignColumns: [actionJob.id, actionJob.organizationId],
      name: "action_storage_job_owner_fk",
    }).onDelete("restrict"),
    index("action_storage_run_idx").on(t.organizationId, t.runId, t.kind, t.state),
    index("action_storage_cache_idx").on(t.organizationId, t.repository, t.ref, t.kind, t.state),
    index("action_storage_expiry_idx").on(t.expiresAt),
  ],
);

/** Each attempted upload is recorded BEFORE any object write, so cleanup can
 * reclaim uncertain uploads without listing another customer's storage. */
export const actionStorageChunk = pgTable(
  "action_storage_chunk",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    objectId: integer("object_id").notNull(),
    kind: text("kind").$type<"part" | "assembly">().notNull().default("part"),
    name: text("name").notNull(),
    key: text("key").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256"),
    state: text("state").$type<"pending" | "complete">().notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.objectId, t.organizationId],
      foreignColumns: [actionStorageObject.id, actionStorageObject.organizationId],
      name: "action_storage_chunk_owner_fk",
    }).onDelete("cascade"),
    index("action_storage_chunk_object_idx").on(t.objectId, t.createdAt),
  ],
);
