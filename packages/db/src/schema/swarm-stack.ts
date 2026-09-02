import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  SwarmDriftStatus,
  SwarmManagementMode,
  SwarmRevisionStatus,
  SwarmRoutingMode,
  SwarmSourceKind,
  SwarmSourceStatus,
} from "@repo/core";
import { organization } from "./organization";
import { project } from "./project";
import { servers } from "./servers";
import { containerRegistry } from "./container-registry";

/** Persisted binding for one source-backed Docker Swarm stack. */
export const swarmStack = pgTable(
  "swarm_stack",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** The OpenShip server row that reaches the manager; no Docker action on FK cascade. */
    managerServerId: text("manager_server_id").references(() => servers.id, { onDelete: "set null" }),
    clusterId: text("cluster_id").notNull(),
    stackName: text("stack_name").notNull(),
    /** Observe is the import default and has no mutation authority. */
    managementMode: text("management_mode").$type<SwarmManagementMode>().notNull().default("observe"),
    /** Repository source, encrypted inline source, or an adopted live stack. */
    sourceKind: text("source_kind").$type<SwarmSourceKind>().notNull().default("inline"),
    sourceStatus: text("source_status").$type<SwarmSourceStatus>().notNull().default("missing"),
    /** Ordered repository-relative source paths, used only under a private staging root. */
    sourcePaths: jsonb("source_paths").$type<string[]>().notNull().default([]),
    sourcePath: text("source_path"),
    /** Optional immutable Git ref captured for a repository-backed source. */
    sourceBranch: text("source_branch"),
    sourceCommitSha: text("source_commit_sha"),
    /** Optimistic concurrency token for source edits. */
    sourceVersion: integer("source_version").notNull().default(1),
    /** Encrypted complete source/YAML document (enc1: envelope), never returned by default. */
    sourceYamlEnc: text("source_yaml_enc"),
    sourceDigest: text("source_digest"),
    /** Existing routing is preserved unless the owner explicitly chooses the Edge path. */
    routingMode: text("routing_mode").$type<SwarmRoutingMode>().notNull().default("external"),
    registryId: text("registry_id").references(() => containerRegistry.id, { onDelete: "set null" }),
    prune: boolean("prune").notNull().default(false),
    resolveImage: text("resolve_image").notNull().default("changed"),
    withRegistryAuth: boolean("with_registry_auth").notNull().default(false),
    /** Exact storage-risk findings an operator has explicitly reviewed as safe. */
    storageAcknowledgements: jsonb("storage_acknowledgements").$type<string[]>().notNull().default([]),
    /** Explicit approval for replacing a previously attached stateful volume identity. */
    volumeReplacementAcknowledgements: jsonb("volume_replacement_acknowledgements").$type<string[]>().notNull().default([]),
    lastObservedDigest: text("last_observed_digest"),
    /** Kept as an ID rather than a cyclic FK; revision ownership is enforced through stackId. */
    lastAppliedRevisionId: text("last_applied_revision_id"),
    driftStatus: text("drift_status").$type<SwarmDriftStatus>().notNull().default("unknown"),
    driftDetails: jsonb("drift_details").$type<Record<string, unknown>>().notNull().default({}),
    /** Redacted observed manager state; does not contain secret payloads. */
    observedState: jsonb("observed_state").$type<Record<string, unknown>>().default({}),
    lastObservedAt: timestamp("last_observed_at"),
    claimedAt: timestamp("claimed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_swarm_stack_project").on(t.projectId),
    uniqueIndex("uq_swarm_stack_cluster_name").on(t.organizationId, t.clusterId, t.stackName),
    /** One live stack binding may belong to only one OpenShip organization. */
    uniqueIndex("uq_swarm_stack_cluster_name_global").on(t.clusterId, t.stackName),
    index("idx_swarm_stack_org_manager").on(t.organizationId, t.managerServerId),
    index("idx_swarm_stack_observe")
      .on(t.organizationId, t.managementMode)
      .where(sql`${t.managementMode} = 'observe'`),
  ],
);

/** Immutable rendered revision captured before a managed stack apply. */
export const swarmStackRevision = pgTable(
  "swarm_stack_revision",
  {
    id: text("id").primaryKey(),
    stackId: text("stack_id")
      .notNull()
      .references(() => swarmStack.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    sourceDigest: text("source_digest"),
    /** Repository commit used to render this immutable revision, when applicable. */
    sourceCommitSha: text("source_commit_sha"),
    /** Encrypted, immutable rendered `docker stack config` output. */
    renderedYamlEnc: text("rendered_yaml_enc").notNull(),
    renderedDigest: text("rendered_digest").notNull(),
    /** Review-safe documents and manifests. No secret contents are persisted here. */
    renderedYamlRedacted: text("rendered_yaml_redacted"),
    overrideYamlRedacted: text("override_yaml_redacted"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    serviceImages: jsonb("service_images").$type<Record<string, string>>().notNull().default({}),
    serviceRefs: jsonb("service_refs").$type<Record<string, unknown>>().notNull().default({}),
    configRefs: jsonb("config_refs").$type<string[]>().notNull().default([]),
    secretRefs: jsonb("secret_refs").$type<string[]>().notNull().default([]),
    applyStatus: text("apply_status").$type<SwarmRevisionStatus>().notNull().default("previewed"),
    applyOutput: jsonb("apply_output").$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: text("created_by_user_id"),
    appliedAt: timestamp("applied_at"),
    convergedAt: timestamp("converged_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_swarm_stack_revision").on(t.stackId, t.revision),
    index("idx_swarm_stack_revision_stack_created").on(t.stackId, t.createdAt),
  ],
);

/**
 * Operator-entered payload for a project-managed Swarm config or secret.
 * Values are application-encrypted and are deliberately absent from all
 * discovery, source, revision-manifest, and list/read DTO surfaces.
 */
export const swarmManagedInput = pgTable(
  "swarm_managed_input",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"config" | "secret">().notNull(),
    logicalName: text("logical_name").notNull(),
    valueEnc: text("value_enc").notNull(),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_swarm_managed_input_project_kind_logical").on(t.projectId, t.kind, t.logicalName),
    index("idx_swarm_managed_input_project").on(t.projectId),
  ],
);
