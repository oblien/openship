import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * A durable reservation in one physical host's TCP bind namespace.
 *
 * Claims are intentionally installation-local and intentionally detached from
 * project/service foreign keys:
 *
 * - organization boundaries do not partition a host's ports;
 * - stopped containers still own their routed port;
 * - record-only/force-orphan cleanup may remove the project rows while an edge
 *   vhost still targets the port.
 *
 * The owner tuple is stable across deployments. A single app has a null service
 * id and normally uses its routed container/app port; legacy single-app claims
 * may have a null container port. A compose claim uses its service id and routed
 * container port. Rows disappear only through an explicit release/prune.
 */
export const hostPortClaim = pgTable(
  "host_port_claim",
  {
    id: text("id").primaryKey(),
    /** `local`, physical `host:<sha256>`, or a legacy `server:<id>` alias. */
    targetKey: text("target_key").notNull(),
    /** Loopback TCP port bound on the physical target. */
    port: integer("port").notNull(),
    /** Stable owner ids; deliberately not foreign keys — see table comment. */
    projectId: text("project_id").notNull(),
    serviceId: text("service_id"),
    /** Null only when a legacy scalar did not record its container/app port. */
    containerPort: integer("container_port"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // The database, not a preceding list query, is the final collision arbiter.
    uniqueIndex("uq_host_port_claim_target_port").on(t.targetKey, t.port),
    // PostgreSQL treats nulls as distinct, so expression sentinels make the
    // stable single-app/legacy owner identities genuinely unique too.
    uniqueIndex("uq_host_port_claim_target_owner").on(
      t.targetKey,
      t.projectId,
      sql`coalesce(${t.serviceId}, '')`,
      sql`coalesce(${t.containerPort}, 0)`,
    ),
    index("idx_host_port_claim_project").on(t.projectId),
    check(
      "ck_host_port_claim_target_key",
      sql`${t.targetKey} = 'local' OR ${t.targetKey} ~ '^host:[0-9a-f]{64}$' OR (${t.targetKey} LIKE 'server:%' AND length(${t.targetKey}) > 7)`,
    ),
    check("ck_host_port_claim_port", sql`${t.port} BETWEEN 1 AND 65535`),
    check(
      "ck_host_port_claim_container_port",
      sql`${t.containerPort} IS NULL OR ${t.containerPort} BETWEEN 1 AND 65535`,
    ),
  ],
);
