import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organization } from "./organization";

/**
 * Orphaned remote resources awaiting garbage collection.
 *
 * Written when a project is force-orphan deleted while its server is
 * UNREACHABLE: the DB row is dropped so the user isn't blocked, and the leaked
 * remote resources (containers/images/volumes/networks/routes/cloud workspaces) are
 * recorded here instead of being silently abandoned. A periodic GC sweep probes
 * each `server_id`; once reachable it destroys the resource (idempotently) and
 * deletes this row.
 *
 * `server_id` is intentionally NOT a FK: a removed server must not cascade-drop
 * the record (we still want the row so GC can confirm/skip it), and the GC job
 * handles a vanished server by dropping the orphan itself.
 */
export const orphanedResource = pgTable(
  "orphaned_resource",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** SSH server the resource lives on. Null for cloud resources. No FK — see doc. */
    serverId: text("server_id"),
    /** Immutable physical bind namespace; unlike serverId, aliases cannot split GC ordering. */
    targetKey: text("target_key"),
    /** container | image | volume | network | route | host_port_claims | cloud_workspace */
    resourceType: text("resource_type").notNull(),
    /** The runtime ref to destroy (container id, image tag, volume name, …). */
    ref: text("ref").notNull(),
    /** Originating project (already deleted — for forensics/UI only, no FK). */
    projectId: text("project_id"),
    /** Human-readable label carried from the cleanup manifest. */
    label: text("label"),
    /** docker | bare | cloud — which runtime adapter GC must resolve. */
    runtimeMode: text("runtime_mode"),
    /** Extra data GC may need (e.g. cloud workspace/org identifiers). */
    payload: jsonb("payload"),
    /** GC attempt counter — bumped when a sweep can't yet destroy it. */
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("orphaned_resource_server_idx").on(t.serverId),
    index("orphaned_resource_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);
