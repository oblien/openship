import { pgTable, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ClusterNetworkReport, InfrastructureProviderId } from "@repo/core";
import { organization } from "./organization";
import { servers } from "./servers";

export const serverCluster = pgTable(
  "server_cluster",
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
    requestId: text("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("server_cluster_request_idx").on(table.organizationId, table.requestId)],
);

export const clusterNetwork = pgTable(
  "cluster_network",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => serverCluster.id, { onDelete: "cascade" }),
    mode: text("mode").$type<"native">().notNull(),
    cidrs: jsonb("cidrs").$type<string[]>().notNull(),
    mtu: integer("mtu").notNull(),
    probePort: integer("probe_port").notNull(),
    ownership: text("ownership").$type<"external">().notNull().default("external"),
  },
  (table) => [uniqueIndex("cluster_network_cluster_idx").on(table.clusterId)],
);

export const clusterMember = pgTable(
  "cluster_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => serverCluster.id, { onDelete: "cascade" }),
    // Migration makes this deferred: organization cascades cross both parent trees.
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "no action" }),
    hostIdentity: text("host_identity"),
  },
  (table) => [
    uniqueIndex("cluster_member_server_idx").on(table.serverId),
    uniqueIndex("cluster_member_host_idx")
      .on(table.hostIdentity)
      .where(sql`${table.hostIdentity} is not null`),
    index("cluster_member_cluster_idx").on(table.clusterId),
  ],
);

/** Separate from compute membership so a server can attach to multiple networks. */
export const serverNetworkAttachment = pgTable(
  "server_network_attachment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    networkId: text("network_id")
      .notNull()
      .references(() => clusterNetwork.id, { onDelete: "cascade" }),
    // See clusterMember: PostgreSQL checks this FK at transaction commit.
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "no action" }),
    providerId: text("provider_id").$type<InfrastructureProviderId>().notNull(),
    privateIp: text("private_ip").notNull(),
    interfaceName: text("interface_name"),
    networkRef: text("network_ref"),
  },
  (table) => [
    uniqueIndex("server_network_attachment_server_idx").on(table.networkId, table.serverId),
    uniqueIndex("server_network_attachment_address_idx").on(table.networkId, table.privateIp),
  ],
);

export const clusterVerification = pgTable(
  "cluster_verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => serverCluster.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    status: text("status").$type<"running" | "succeeded" | "failed" | "interrupted">().notNull(),
    report: jsonb("report").$type<ClusterNetworkReport>().notNull(),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    index("cluster_verification_cluster_idx").on(table.clusterId, table.startedAt),
    uniqueIndex("cluster_verification_active_idx")
      .on(table.clusterId)
      .where(sql`${table.status} = 'running'`),
  ],
);
