import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { servers } from "./servers";
import { serverCluster as privateNetwork, clusterMember as networkMember } from "./server-cluster";

/** A compute pool references connectivity; it never owns the network lifecycle. */
export const computeCluster = pgTable(
  "compute_cluster",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    location: text("location"),
    revision: integer("revision").notNull().default(1),
    networkId: text("network_id")
      .notNull()
      .references(() => privateNetwork.id, { onDelete: "no action" }),
    requestId: text("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("compute_cluster_request_idx").on(table.organizationId, table.requestId),
    uniqueIndex("compute_cluster_id_network_idx").on(table.id, table.networkId),
    index("compute_cluster_network_idx").on(table.networkId),
  ],
);

/** Composite references are deferred by the migration, allowing atomic membership updates. */
export const computeClusterMember = pgTable(
  "compute_cluster_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => computeCluster.id, { onDelete: "cascade" }),
    networkId: text("network_id").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "no action" }),
  },
  (table) => [
    uniqueIndex("compute_cluster_member_server_idx").on(table.serverId),
    index("compute_cluster_member_cluster_idx").on(table.clusterId),
    foreignKey({
      columns: [table.clusterId, table.networkId],
      foreignColumns: [computeCluster.id, computeCluster.networkId],
    }).onDelete("no action"),
    foreignKey({
      columns: [table.networkId, table.serverId],
      foreignColumns: [networkMember.clusterId, networkMember.serverId],
    }).onDelete("no action"),
  ],
);
