import { pgTable, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  ClusterNetworkReport,
  InfrastructureProviderId,
  ManagedNetworkPlan,
  ManagedNetworkHostProgress,
  ManagedNetworkOperationStatus,
  ManagedNetworkPreparation,
  ManagedNetworkPreparationInput,
  ManagedNetworkPreparationHost,
  NativeNetworkSource,
  NetworkAccessPolicy,
} from "@repo/core";
import { organization } from "./organization";
import { servers } from "./servers";

/** Prerequisite work is durable before a valid network plan can exist. */
export const managedNetworkPreparation = pgTable(
  "managed_network_preparation",
  {
    id: text("id").primaryKey(),
    sequence: integer("sequence").notNull().default(1),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    inputHash: text("input_hash").notNull(),
    input: jsonb("input").$type<ManagedNetworkPreparationInput>().notNull(),
    status: text("status").$type<ManagedNetworkPreparation["status"]>().notNull(),
    hosts: jsonb("hosts").$type<ManagedNetworkPreparationHost[]>().notNull(),
    operationId: text("operation_id"),
    replacementPreparationId: text("replacement_preparation_id"),
    cleanupOperationId: text("cleanup_operation_id"),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    generation: integer("generation").notNull().default(1),
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("managed_network_preparation_org_idx").on(table.organizationId, table.createdAt),
  ],
);

/** Independent network inventory. Export names and journal fields remain compatible with v1. */
export const serverCluster = pgTable(
  "private_network",
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
  "private_network_config",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    clusterId: text("network_id")
      .notNull()
      .references(() => serverCluster.id, { onDelete: "cascade" }),
    mode: text("mode").$type<"native" | "wireguard">().notNull(),
    source: jsonb("source").$type<NativeNetworkSource>(),
    access: jsonb("access").$type<NetworkAccessPolicy>(),
    cidrs: jsonb("cidrs").$type<string[]>().notNull(),
    mtu: integer("mtu").notNull(),
    probePort: integer("probe_port").notNull(),
    ownership: text("ownership").$type<"external" | "openship">().notNull().default("external"),
    managedId: text("managed_id"),
    interfaceName: text("interface_name"),
  },
  (table) => [uniqueIndex("cluster_network_cluster_idx").on(table.clusterId)],
);

export const clusterMember = pgTable(
  "network_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    clusterId: text("network_id")
      .notNull()
      .references(() => serverCluster.id, { onDelete: "cascade" }),
    // Migration makes this deferred: organization cascades cross both parent trees.
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "no action" }),
    hostIdentity: text("host_identity"),
  },
  (table) => [
    uniqueIndex("network_member_server_idx").on(table.clusterId, table.serverId),
    uniqueIndex("network_member_host_idx")
      .on(table.clusterId, table.hostIdentity)
      .where(sql`${table.hostIdentity} is not null`),
    index("cluster_member_cluster_idx").on(table.clusterId),
    index("network_member_inventory_idx").on(table.serverId),
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
    endpoint: text("endpoint"),
    listenPort: integer("listen_port"),
    publicKey: text("public_key"),
  },
  (table) => [
    uniqueIndex("server_network_attachment_server_idx").on(table.networkId, table.serverId),
    uniqueIndex("server_network_attachment_address_idx").on(table.networkId, table.privateIp),
  ],
);

/** Durable, secret-free approval and recovery journal. Plans precede cluster creation. */
export const managedNetworkOperation = pgTable(
  "managed_network_operation",
  {
    id: text("id").primaryKey(),
    sequence: integer("sequence").notNull().default(1),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clusterId: text("network_id").notNull(),
    inputHash: text("input_hash").notNull(),
    planHash: text("plan_hash").notNull(),
    plan: jsonb("plan").$type<ManagedNetworkPlan>().notNull(),
    replacementPreparationId: text("replacement_preparation_id"),
    status: text("status").$type<ManagedNetworkOperationStatus>().notNull(),
    hosts: jsonb("hosts").$type<ManagedNetworkHostProgress[]>().notNull(),
    report: jsonb("report").$type<ClusterNetworkReport | null>(),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    generation: integer("generation").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("managed_network_operation_cluster_idx").on(
      table.organizationId,
      table.clusterId,
      table.createdAt,
    ),
    uniqueIndex("managed_network_operation_active_idx")
      .on(table.clusterId)
      .where(
        sql`${table.status} in ('applying', 'verifying', 'committing', 'rolling_back', 'interrupted', 'needs_attention')`,
      ),
  ],
);

/** Reserves joining/leaving servers until every host confirms commit or rollback. */
export const managedNetworkClaim = pgTable(
  "managed_network_claim",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "no action" }),
    hostIdentity: text("host_identity").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clusterId: text("network_id").notNull(),
    operationId: text("operation_id")
      .notNull()
      .references(() => managedNetworkOperation.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("managed_network_claim_host_idx").on(table.hostIdentity)],
);

export const clusterVerification = pgTable(
  "network_verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    clusterId: text("network_id")
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
