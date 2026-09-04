/**
 * Database dump / restore primitives — power team-mode migration AND
 * per-project transfer between local and Openship Cloud.
 *
 * A subgraph is a coherent, FK-closed slice of the DB. Three flavors today:
 *
 *   instance     — every migration-managed table, every row. Used by
 *                  single-tenant migrations (Path A: VPS, Path B: cloud
 *                  ingest forward path).
 *   organization — rows tagged with a specific organizationId, plus
 *                  FK-resolved children. Used by SaaS cloud-ingest export
 *                  (multi-tenant) and the team-mode flows.
 *   project      — a single project + every row reachable via FK from it.
 *                  Used by project-transfer (per-project mobility between
 *                  local <-> cloud).
 *
 * Why not pg_dump? Because:
 *   1. PGlite has no `pg_dump` binary — it's WASM, not a daemon.
 *   2. Cross-version restores (PGlite → managed Postgres) can choke on
 *      pg_dump's `CREATE EXTENSION` / search_path / role preamble.
 *   3. Drizzle owns the schema; the destination has applied the same
 *      migrations already — we ship data, not DDL.
 *
 * NOT a backup tool. Use the existing backup module for that.
 */

import { sql, eq, inArray, count, getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db, getDriver, type DatabaseTransaction } from "./client";
import * as schema from "./schema";

export const DUMP_FORMAT_VERSION = 1;

// ─── Scope discriminated union ───────────────────────────────────────────────
//
// The shape exposes the same `tables` envelope regardless of `kind`, so the
// restore path is identical.

export type SubgraphScope =
  | { kind: "instance" }
  | { kind: "organization"; organizationId: string }
  | { kind: "project"; projectId: string };

export interface DumpOptions {
  /** Null encrypted-at-rest columns; required for cross-host moves. */
  stripEncrypted?: boolean;
  /**
   * Null FK columns that point at INSTANCE-scope-only parents; required for
   * cross-instance moves for the same reason `stripEncrypted` is.
   *
   * `servers` and `mail_servers` are declared instance-scope only, so they never
   * travel in an organization or project dump — but their CHILDREN do, carrying a
   * dangling reference. On a receiver where those tables are permanently empty (the
   * SaaS never registers a server row) the FKs are not DEFERRABLE, so the insert
   * takes a raw FK violation and promote-to-cloud / migrate-to-cloud fails outright.
   *
   * Scrubbing rather than rejecting, because a local project legitimately HAS a
   * serverId — it just means nothing on the destination. Once scrubbed, any non-null
   * value in a remapped dump can only have been crafted, which is what lets
   * `assertDumpSelfContained` reject those columns outright.
   */
  stripInstanceRefs?: boolean;
  /**
   * Skip selected catalogue tables at query time. Intended for trusted,
   * dependency-aware callers such as the instance export history filter; an
   * arbitrary caller must not remove FK parents while retaining their children.
   */
  excludeTables?: readonly string[];
}

/**
 * FK columns whose parent is instance-scope only, keyed by dump table sqlName.
 * Shared by the dump-side scrub and the ingest-side self-containment assert so the
 * two cannot drift.
 */
export const INSTANCE_SCOPED_REFS: Record<string, readonly string[]> = {
  project: ["serverId"],
  backup_destination: ["serverId"],
  backup_policy: ["mailServerId"],
  backup_run: ["mailServerId"],
  backup_restore: ["forkMailServerId"],
};

export interface DatabaseDump {
  formatVersion: number;
  exportedAt: string;
  sourceDriver: "pg" | "pglite";
  /** Echoed back so restore can sanity-check intent vs. payload shape. */
  scope: SubgraphScope;
  tables: Record<string, Array<Record<string, unknown>>>;
  strippedEncryptedFields?: Array<{ table: string; column: string; rowsAffected: number }>;
}

/**
 * Thrown by restoreSubgraph when an INSERT hits a unique-constraint
 * violation (Postgres unique_violation, code 23505 — a duplicate PK OR
 * a duplicate unique column such as domain.hostname). Callers map this
 * to a friendly 409 — "this row already exists on the target" (the
 * operator already transferred this project, or a hostname collides).
 */
export class PkCollisionError extends Error {
  readonly code = "PK_COLLISION" as const;
  constructor(
    public readonly table: string,
    public readonly cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Duplicate key on ${table} during restore — this subgraph appears to already exist on the target. (${causeMessage})`,
    );
    this.name = "PkCollisionError";
  }
}

/**
 * Extract the underlying Postgres driver error (with its `.code`) from a
 * thrown error. Drizzle wraps the driver error in a `DrizzleQueryError`, so
 * the pg code (e.g. 23505 = unique_violation) lives on `.cause`, not the
 * top level. Walk the cause chain (bounded) and return the first link that
 * carries a string `code`.
 */
function resolvePgError(err: unknown): (Error & { code?: string }) | null {
  let e: unknown = err;
  for (let i = 0; i < 6 && e && typeof e === "object"; i++) {
    if (typeof (e as { code?: unknown }).code === "string") {
      return e as Error & { code?: string };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Drop the keys of a dumped row that THIS build's schema doesn't model, so a
 * version-skewed dump ingests cleanly. Drizzle derives the INSERT column list
 * from the row's keys, so a column present on a NEWER sender but absent on this
 * (older) receiver would make Postgres reject the whole insert ("column X of
 * relation Y does not exist"). Filtering to `knownCols` (the receiver's columns)
 * removes exactly those — the receiver can't store what it doesn't model anyway.
 * The reverse skew (receiver has a column the dump lacks) is handled by Drizzle
 * emitting DEFAULT, which is why additive migrations MUST be nullable/defaulted.
 *
 * Exported for the version-skew tolerance test. Pure — no DB access.
 */
export function filterRowToKnownColumns(
  row: Record<string, unknown>,
  knownCols: ReadonlySet<string>,
): { row: Record<string, unknown>; dropped: string[] } {
  const next: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (knownCols.has(k)) next[k] = v;
    else dropped.push(k);
  }
  return { row: next, dropped };
}

// ─── Table catalogue ─────────────────────────────────────────────────────────
//
// One declarative table per row. `scopes` describes which subgraphs include
// it and how it's resolved. The same table can appear in multiple subgraphs
// via different relations.

type ScopeResolver =
  // Root row of the subgraph — selected by primary key.
  | { in: "project"; via: "root-project-id" }
  | { in: "organization"; via: "organizationId" }
  // Resolved by FK to an already-collected set of parent ids.
  | { in: "project"; via: "fk"; column: "projectId" }
  | { in: "project"; via: "fk"; column: "deploymentId" }
  | { in: "project"; via: "fk"; column: "serviceId" }
  | { in: "organization"; via: "fk"; column: "projectId" }
  | { in: "organization"; via: "fk"; column: "deploymentId" }
  // Resolved by reading a column on the ROOT project row, then
  // selecting THIS table where id = that value. Used to bring along
  // FK-target rows the project depends on (e.g. project_app via
  // project.groupId). The walker fetches the root project on demand.
  | { in: "project"; via: "from-root-project"; sourceColumn: "groupId" }
  // Whole-instance only.
  | { in: "instance"; via: "all-rows" };

export interface TableSpec {
  sqlName: string;
  table: PgTable;
  /** Strategies this table participates in, in evaluation order. */
  scopes: ScopeResolver[];
  /** When true, rows have an organizationId column (needed by remapOrgId). */
  hasOrganizationId: boolean;
}

const TABLES: ReadonlyArray<TableSpec> = [
  // Auth + identity — instance-only (SaaS already has its own user/auth rows).
  {
    sqlName: "user",
    table: schema.user,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "organization",
    table: schema.organization,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "account",
    table: schema.account,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "session",
    table: schema.session,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "member",
    table: schema.member,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "invitation",
    table: schema.invitation,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "invitation_pending_grant",
    table: schema.invitationPendingGrant,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "resource_grant",
    table: schema.resourceGrant,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "personal_access_token",
    table: schema.personalAccessToken,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  // The SCOPE of every scoped PAT. Travels with its token row or the token lands on
  // the receiver as a scoped principal with zero grants — which fails closed (every
  // resource check denies), so each scoped token silently stops working.
  {
    sqlName: "personal_access_token_grant",
    table: schema.personalAccessTokenGrant,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  // OAuth 2.1 authorization-server state for MCP connections (Better Auth
  // oidc-provider). The client REGISTRATION and the user's CONSENT travel so an
  // already-connected MCP client can re-authenticate itself on the receiver;
  // `oauth_access_token` deliberately does not (see EXCLUDED_TABLES) — shipping live
  // bearer tokens in an export file buys nothing a refresh doesn't.
  {
    sqlName: "oauth_application",
    table: schema.oauthApplication,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "oauth_consent",
    table: schema.oauthConsent,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },

  // User / instance settings — instance-only.
  //
  // SECURITY NOTE: do NOT add an organization or project scope resolver
  // here. instance-scope dumps are rejected on the SaaS-side ingest
  // (cloud-ingest.service rejects scope.kind === "instance"), and that
  // rejection is what keeps user_settings.cloudSessionToken +
  // cloneTokenEncrypted from ever leaving the SaaS DB via the dump path.
  // Adding an org/project scope here would route user_settings rows
  // through the cloud export endpoint and around that gate.
  {
    sqlName: "user_settings",
    table: schema.userSettings,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "instance_settings",
    table: schema.instanceSettings,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },

  // Infra — instance-only.
  {
    sqlName: "servers",
    table: schema.servers,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "server_tunnels",
    table: schema.serverTunnels,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "mail_servers",
    table: schema.mailServers,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },

  // GitHub — instance-only.
  // Custom App credentials are tied to this control plane's callback/webhook
  // URLs. They travel in a whole-instance migration (with secrets re-sealed),
  // but never in a project/org promotion to another control plane.
  {
    sqlName: "git_source",
    table: schema.gitSource,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  {
    sqlName: "git_installation",
    table: schema.gitInstallation,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "cloud_webhook_binding",
    table: schema.cloudWebhookBinding,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  // How each server authenticates to GitHub for clone-on-server, and the per-repo
  // deploy keys that back `ssh-deploy-key` mode. Both hang off `servers`, so both are
  // instance-only — and both carry secrets registered in ENCRYPTED_COLUMNS, so the
  // ciphertext is stripped and re-sealed under the receiver's key rather than
  // travelling undecryptable.
  {
    sqlName: "server_github_auth",
    table: schema.serverGithubAuth,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  {
    sqlName: "github_deploy_key",
    table: schema.githubDeployKey,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },

  // ── Project subgraph (also part of organization scope) ─────────────────────
  //
  // project_app is the parent of project (project.groupId NOT NULL FK).
  // For project scope we MUST include it — restore would otherwise fail
  // its FK check at COMMIT time. Resolver walks project.groupId off the
  // root project row and selects the matching project_app row.
  {
    sqlName: "project_app",
    table: schema.projectGroup,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      { in: "project", via: "from-root-project", sourceColumn: "groupId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "project",
    table: schema.project,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      { in: "project", via: "root-project-id" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "env_var",
    table: schema.envVar,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "deployment",
    table: schema.deployment,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "domain",
    table: schema.domain,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "service",
    table: schema.service,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "service_deployment",
    table: schema.serviceDeployment,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "deploymentId" },
      { in: "project", via: "fk", column: "deploymentId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "incoming_webhook",
    table: schema.incomingWebhook,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: true,
  },
  // Per-route edge rules (rate-limit / ban / allow-deny). The DB is the source of
  // truth — the API serializes these into OpenResty's shared dict — so an instance
  // that loses them silently drops every rate limit it was enforcing. Project-scoped
  // as well, so a project transfer carries its own rules; `domainId` stays
  // self-contained because a project's rules only ever reference that project's
  // domains, which travel in the same scope.
  {
    sqlName: "route_rule",
    table: schema.routeRule,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: true,
  },
  // Inbound webhook SOURCES (Settings → Webhooks). MUST be catalogued: `domain`
  // carries a `webhookSourceId` FK to it, so the first row this table ever holds
  // makes an import fail on a violation no reordering can fix. Latent rather than
  // live so far only because the table has a repo but no writer yet — and its HMAC
  // secret was ALREADY registered in ENCRYPTED_COLUMNS + SECRET_COLUMNS, so the
  // export/re-seal machinery for it was dead code while the rows never travelled.
  //
  // Instance-scope ONLY, deliberately: a webhook-owned domain has a null projectId,
  // so it never travels in an organization/project dump and the parent is not needed
  // there. Adding an org scope would put a secret-bearing table on the cloud-export
  // surface for no gain.
  {
    sqlName: "webhook_source",
    table: schema.webhookSource,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  // DB-app → consumer links. Instance-scope only: a row references TWO projects
  // (source + target), so a single-project transfer would carry a reference to a
  // project that stays behind — the same dangling-parent reason backup_policy is
  // instance/org only.
  {
    sqlName: "project_connection",
    table: schema.projectConnection,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },

  // Backups
  {
    sqlName: "backup_destination",
    table: schema.backupDestination,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      // Not project-scoped: destinations are org-shared; transfer leaves
      // them behind on the source.
    ],
    hasOrganizationId: true,
  },
  // backup_policy / backup_run / backup_restore are intentionally NOT
  // in project scope. They reference backup_destination via NOT-NULL FK
  // (destinationId), and backup_destination is org-shared (not project-
  // scoped) — including these rows in a project transfer would leave
  // dangling FK references on the target. Backup history "stays behind
  // on the source"; the operator re-binds a destination on the new host.
  // Organization scope DOES carry them (backup_destination travels along).
  {
    sqlName: "backup_policy",
    table: schema.backupPolicy,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "backup_run",
    table: schema.backupRun,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "backup_restore",
    table: schema.backupRestore,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      // See note on backup_policy / backup_run — not project-scoped.
    ],
    hasOrganizationId: true,
  },

  // DNS
  // Carried by an org transfer so the receiving instance keeps writing that org's
  // domain records instead of silently reverting them to manual. Paired with its
  // ENCRYPTED_COLUMNS spec below: catalogued without one, the restore-side null
  // pass skips api_token_enc and a crafted ingest could plant ciphertext for a
  // zone the tenant does not own.
  {
    sqlName: "dns_credential",
    table: schema.dnsCredential,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
    ],
    hasOrganizationId: true,
  },

  // Credentials
  // The generic third-party credential store (registry logins, DNS tokens). Carried by an
  // org transfer for the same reason dns_credential is: without it the receiving instance
  // silently loses the ability to pull that org's private images or write its DNS records.
  // Paired with its ENCRYPTED_COLUMNS spec below — catalogued WITHOUT one, the restore-side
  // redaction pass skips secrets_enc and a crafted ingest could plant ciphertext for a
  // registry the tenant does not own.
  {
    sqlName: "credential",
    table: schema.credential,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
    ],
    hasOrganizationId: true,
  },

  // Notifications
  {
    sqlName: "notification_channel",
    table: schema.notificationChannel,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  // notification_subscription / notification_delivery reference
  // notification_channel (INSTANCE-scope only, above) via channelId, which never
  // travels on an org/project (remap) dump. Carrying them there would create
  // dangling channel FKs on the target AND let a crafted ingest attach a
  // subscription/delivery to a VICTIM tenant's channel (self-containment can
  // never hold for channelId in these scopes). So — exactly like backup_run for
  // project scope — they are organization-scope EXCLUDED: a full instance
  // migration still carries them (the channel travels alongside), but a
  // cross-org remap does not. notification_default has no channel FK and stays.
  {
    sqlName: "notification_subscription",
    table: schema.notificationSubscription,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  {
    sqlName: "notification_default",
    table: schema.notificationDefault,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "notification_delivery",
    table: schema.notificationDelivery,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },

  // Inbound-mail notification rules — instance-scope ONLY, exactly like their
  // `mail_servers` parent and `notification_channel`, even though the rule row carries an
  // organizationId. An organization scope here would ship a `server_id` and a
  // `channel_ids` array whose targets are instance-scope and therefore absent from the
  // dump: on the receiver they would dangle, or — worse — resolve to a PRE-EXISTING row
  // belonging to somebody else.
  {
    sqlName: "mail_inbound_rule",
    table: schema.mailInboundRule,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },

  // Analytics + audit — instance-only.
  {
    sqlName: "server_analytics",
    table: schema.serverAnalytics,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "server_analytics_geo",
    table: schema.serverAnalyticsGeo,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  // Project-scoped, unlike the two above (which are keyed by server + domain). So it
  // carries a project scope as well as the instance one, and a project transfer takes
  // its usage history along instead of silently resetting the charts on the receiver.
  {
    sqlName: "resource_usage",
    table: schema.resourceUsage,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "audit_event",
    table: schema.auditEvent,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  // Travels with audit_event: without it, an instance migration silently turns
  // audit recording back on for an org that had switched it off.
  {
    sqlName: "audit_settings",
    table: schema.auditSettings,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },

  // ── Operator-owned state, instance-only ────────────────────────────────────
  //
  // Each of these is durable configuration or durable history that only the operator
  // can reproduce, and every one of them hangs off an instance-scope parent
  // (`servers` / `user` / `personal_access_token`) or has no parent at all.

  // Scheduled-task DEFINITIONS. The boot reconciler re-seeds system jobs from the
  // code registry, but the operator's own cron retunes and disables live only here.
  // `key` is UNIQUE and every install seeds the same keys, so a MERGE import must
  // keep the destination's rows — see SINGLETON_AND_AUTH in import.service.
  {
    sqlName: "job",
    table: schema.job,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  // Per-org uploaded app templates — the org's own catalog cards.
  {
    sqlName: "custom_app_template",
    table: schema.customAppTemplate,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  // The durable memory behind container health alerts. Losing it re-fires every
  // still-open incident as brand new on the receiver.
  {
    sqlName: "service_incident",
    table: schema.serviceIncident,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  // Docker-migration run history — deliberately durable (the runs list survives a
  // restart), so a transfer that dropped it would contradict that.
  {
    sqlName: "docker_migration_run",
    table: schema.dockerMigrationRun,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  // Proof that a routing target is ours, persisted precisely BECAUSE the upstream's
  // list endpoint never returns the token again — a token that exists only on the old
  // box is unrecoverable, which is exactly what a migration produces.
  {
    sqlName: "edge_target_verification",
    table: schema.edgeTargetVerification,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: true,
  },
  // Operator-pushed status banners; effective immediately, no redeploy, so they are
  // config rather than cache.
  {
    sqlName: "system_notice",
    table: schema.systemNotice,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
];

/**
 * Every migration-managed table deliberately NOT in `TABLES`, with the reason.
 *
 * This is not documentation — it is the other half of a completeness invariant:
 * `TABLES ∪ EXCLUDED_TABLES` must equal every table in the schema, asserted by a
 * test. A new table is then a FAILING TEST rather than silent data loss, which is
 * how ~14 durable tables (webhook_source, route_rule, project_connection, the PAT
 * grants, the per-server GitHub credentials …) came to be missing from a
 * whole-instance export that claims to carry "every migration-managed table".
 */
export const EXCLUDED_TABLES: Record<string, string> = {
  // Ephemeral / in-flight — re-created on demand, meaningless on another host.
  build_session: "in-flight build state; a migration never resumes a build mid-flight",
  deployment_check_run: "GitHub check-run mirror, re-created by the next deploy",
  terminal_sessions: "SSH session audit bound to a live WS; open rows are swept at boot",
  service_terminal_sessions: "as terminal_sessions, for container shells",
  verification: "Better Auth one-shot nonces, all short-TTL",
  github_install_state: "one-shot install nonce, deleted on callback",
  cloud_handoff_code: "60s one-time cloud-connect codes",
  data_transfer_session: "short-lived whole-instance transfer capability and upload lease",
  data_transfer_chunk: "short-lived chunk staging for a whole-instance transfer",
  oauth_access_token:
    "live MCP bearer/refresh tokens; the client re-authenticates against the " +
    "oauth_application + oauth_consent rows that DO travel, so shipping them adds " +
    "credentials to the export file for no gain",

  // Physical-instance state. Moving these rows would reserve source-machine
  // ports on an unrelated destination (or, worse, let a project transfer plant
  // claims in another tenant's bind namespace). The destination allocator
  // creates claims from its own resolved target and live edge state.
  host_port_claim:
    "physical-target port reservations; never export, clone, or transfer across instances",

  // Caches / host-derived — the host, not the DB, is the source of truth.
  update_status: "cached upstream scan result; the next `updates:scan` refills it",
  server_container_status: "cached container drift; re-probed from the host",
  server_module_status: "cached module drift; re-probed from the host",

  // History that is observability only — no config, no pending work, and prunable.
  job_run: "append-only tick log; job DEFINITIONS travel, executions do not",
  webhook_delivery: "inbound delivery feed + GitHub dedup claims, pruned by age",
  oblien_webhook_event: "upstream webhook dedup ledger, cloud-side",

  // Judgement call worth revisiting: this is a pending-work QUEUE, not history —
  // leaked remote resources awaiting GC. An instance migration carries the
  // `servers` rows, so the sweep would still be actionable on the receiver, and
  // dropping the rows abandons the leaks permanently. Left excluded to preserve
  // existing behaviour rather than change it silently.
  orphaned_resource: "GC worklist; loss abandons already-leaked remote resources",

  // CLOUD_MODE-only. Both exportInstance and importInstance refuse outright when
  // CLOUD_MODE is set, so these tables are unreachable by this path by construction.
  billing_customer: "CLOUD_MODE-only",
  billing_subscription: "CLOUD_MODE-only",
  billing_usage_snapshot: "CLOUD_MODE-only",
  billing_anniversary_grant: "CLOUD_MODE-only",
  credit_pack: "CLOUD_MODE-only",
  stripe_topup_grant: "CLOUD_MODE-only",
  stripe_webhook_event: "CLOUD_MODE-only",
};

/** sqlName → PgTable, so redaction can read column metadata (notNull/default). */
const TABLE_BY_SQL_NAME = new Map<string, PgTable>(TABLES.map((t) => [t.sqlName, t.table]));

// ─── Insert order (derived, never hand-maintained) ───────────────────────────
//
// `restoreSubgraph` must insert parents before children, because NONE of the
// schema's foreign keys are declared DEFERRABLE — and Postgres honours
// `SET CONSTRAINTS ALL DEFERRED` only for constraints that are. That statement is
// therefore a silent no-op here (verified against PGlite), which means the insert
// order is the ONLY thing standing between a restore and a raw FK violation.
//
// It used to be the literal order of `TABLES`, maintained by hand. It had drifted
// in four places — `domain` before `service`, `env_var` before `service`,
// `mail_servers` before `project`, `notification_delivery` before `audit_event` —
// so an import died on the first instance that had a domain bound to a service,
// i.e. any project with more than one service. Deriving the order from the real FK
// graph removes ordering from the set of things a human can get wrong: add a table
// anywhere in `TABLES` and it lands in the right place automatically.
//
// `TABLES` order is still meaningful and still authoritative for the DUMP side —
// `dumpSubgraph` walks it so a child's FK-resolution parent ids are collected
// before the child needs them. Only the restore/truncate order is derived.

const CATALOGUED = new Set(TABLES.map((t) => t.sqlName));

/**
 * FK parents of `spec` that are themselves catalogued, as sqlNames. Self-references
 * are dropped: Postgres fires RI triggers at end-of-statement, so a row referencing
 * another row in the same multi-row INSERT is already fine.
 */
function catalogedFkParents(spec: TableSpec): Set<string> {
  const out = new Set<string>();
  for (const fk of getTableConfig(spec.table).foreignKeys) {
    const parent = getTableConfig(fk.reference().foreignTable).name;
    if (parent !== spec.sqlName && CATALOGUED.has(parent)) out.add(parent);
  }
  return out;
}

let topoCache: TableSpec[] | null = null;

/**
 * `TABLES` in a valid parent-before-child order. Kahn's algorithm, kept stable on
 * `TABLES` order so the output is deterministic and diffable. Throws on a cycle
 * rather than emitting a partial order — a cycle means the schema needs a
 * DEFERRABLE constraint and no ordering could save the restore.
 *
 * Exported for the order-invariant test.
 */
export function topoOrderedTables(): TableSpec[] {
  if (topoCache) return topoCache;

  const pending = new Map<string, Set<string>>();
  for (const spec of TABLES) pending.set(spec.sqlName, catalogedFkParents(spec));

  const ordered: TableSpec[] = [];
  const placed = new Set<string>();
  while (placed.size < TABLES.length) {
    // Stable: first table in TABLES order whose parents are all placed.
    const next = TABLES.find(
      (s) => !placed.has(s.sqlName) && [...pending.get(s.sqlName)!].every((p) => placed.has(p)),
    );
    if (!next) {
      const stuck = TABLES.filter((s) => !placed.has(s.sqlName)).map((s) => s.sqlName);
      throw new Error(
        `dump catalogue has a foreign-key cycle involving: ${stuck.join(", ")} — ` +
          `no insert order can satisfy it; the constraint must be made DEFERRABLE.`,
      );
    }
    ordered.push(next);
    placed.add(next.sqlName);
  }

  topoCache = ordered;
  return ordered;
}

/**
 * Largest number of rows of `table` that fit in ONE parameterised INSERT.
 *
 * The restore used to emit a single multi-row INSERT per table, so it broke on any
 * table past its own parameter ceiling — and the error named neither the table nor
 * the row count, just `bind message has N parameter formats but 0 parameters` or
 * `RangeError: Invalid array length`. Any instance with a few thousand audit rows
 * (i.e. any instance that had been running a while) hit it.
 *
 * The budget is 32767, not the 65535 the wire format allows: Postgres encodes a bind
 * message's parameter count as int16, and PGlite's protocol layer reads it SIGNED, so
 * 32768+ wraps negative and dies in the response parser. Measured against PGlite —
 * 32760 parameters succeeds, 32773 fails — and PGlite is the desktop/dev driver, so
 * it sets the ceiling for everyone. 32000 keeps headroom for a receiver whose schema
 * has since gained columns.
 */
const MAX_BIND_PARAMS_PER_STATEMENT = 32_000;

function insertChunkSize(table: PgTable): number {
  const cols = Object.keys(getTableColumns(table)).length || 1;
  return Math.max(1, Math.floor(MAX_BIND_PARAMS_PER_STATEMENT / cols));
}

// ─── Encrypted columns (single source of truth) ──────────────────────────────
//
// Encryption-stripping is centralised here — every dump applies this list when
// stripEncrypted is true.

export interface EncryptedColumnSpec {
  /** SQL table name (dump `tables` key). */
  table: string;
  /** Drizzle field name (matches the keys in selected rows / getTableColumns). */
  column: string;
  /**
   * For a JSONB column where only some sub-fields are secret (e.g.
   * notification_channel.config = { url, hmacSecret }), redact ONLY these
   * top-level keys and leave the rest intact. Absent = the whole column is
   * secret and gets nulled/sentineled wholesale.
   */
  secretPaths?: string[];
}

/**
 * Every encrypted-at-rest column, keyed to its table. Single source of truth
 * for BOTH the dump-side strip (opt-in) and the restore-side null pass
 * (mandatory — see the security note on restoreSubgraph). The
 * data-transfer module re-encrypts these under a passphrase separately.
 *
 * Column value is undecryptable off-instance (key = SHA-256(BETTER_AUTH_SECRET),
 * per-install), so it MUST be redacted on any cross-host move.
 */
export const ENCRYPTED_COLUMNS: ReadonlyArray<EncryptedColumnSpec> = [
  { table: "user_settings", column: "cloudSessionToken" },
  { table: "user_settings", column: "cloneTokenEncrypted" },
  { table: "project", column: "cloneTokenEncrypted" },
  { table: "project", column: "webhookSecret" },
  { table: "cloud_webhook_binding", column: "webhookSecret" },
  { table: "webhook_source", column: "secret" },
  { table: "incoming_webhook", column: "tokenEncrypted" },
  { table: "incoming_webhook", column: "hmacSecretEncrypted" },
  { table: "env_var", column: "value" },
  { table: "backup_destination", column: "accessKeyIdEnc" },
  { table: "backup_destination", column: "secretAccessKeyEnc" },
  { table: "backup_destination", column: "sftpPasswordEnc" },
  { table: "backup_destination", column: "sftpPrivateKeyEnc" },
  { table: "backup_destination", column: "sftpKeyPassphraseEnc" },
  { table: "dns_credential", column: "apiTokenEnc" },
  { table: "credential", column: "secretsEnc" },
  { table: "git_source", column: "secretsEnc" },
  { table: "servers", column: "sshPassword" },
  { table: "servers", column: "sshPrivateKey" },
  { table: "servers", column: "sshKeyPassphrase" },
  // Per-server GitHub identity for clone-on-server. Sealed with the same
  // encrypt()/decrypt() helper as project.webhookSecret (the `scalar` scheme), so
  // it is undecryptable off-instance and must be lifted into the passphrase bundle.
  { table: "server_github_auth", column: "tokenEncrypted" },
  { table: "server_github_auth", column: "serverKeyPrivateEncrypted" },
  // NOT NULL with no default, so the restore-side redaction writes the "" sentinel
  // when no bundle is supplied — same shape as env_var.value.
  { table: "github_deploy_key", column: "privateKeyEncrypted" },
  // Stored in the CLEAR by the Better Auth oidc-provider plugin. Registered anyway
  // so the export moves it out of the JSON payload and into the passphrase-sealed
  // bundle instead of shipping an MCP client secret in plaintext — the same reason
  // instance_settings.tunnelToken is registered with the `plaintext` scheme.
  { table: "oauth_application", column: "clientSecret" },
  { table: "instance_settings", column: "tunnelToken" },
  { table: "instance_settings", column: "ghDeviceTokenEncrypted" },
  { table: "deployment", column: "envVars" },
  { table: "notification_channel", column: "config", secretPaths: ["hmacSecret", "webhookUrl"] },
];

/**
 * Redact one encrypted cell in-place, choosing a value that is still valid to
 * INSERT (this runs on the restore path too). Returns true if it changed
 * anything. Rules:
 *   - secretPaths present → deep-clone the JSONB object, drop only those keys.
 *   - whole column, nullable            → null
 *   - whole column, NOT NULL + default  → delete key (let the DB default apply)
 *   - whole column, NOT NULL, no default → "" sentinel (e.g. env_var.value)
 */
function redactEncryptedCell(
  row: Record<string, unknown>,
  spec: EncryptedColumnSpec,
  columns: Record<string, { notNull: boolean; hasDefault: boolean }>,
): boolean {
  const current = row[spec.column];
  if (current === null || current === undefined) return false;

  if (spec.secretPaths && spec.secretPaths.length > 0) {
    if (typeof current !== "object") return false;
    const clone = structuredClone(current) as Record<string, unknown>;
    let changed = false;
    for (const path of spec.secretPaths) {
      if (clone[path] !== null && clone[path] !== undefined) {
        delete clone[path];
        changed = true;
      }
    }
    if (changed) row[spec.column] = clone;
    return changed;
  }

  const meta = columns[spec.column];
  if (meta?.notNull) {
    if (meta.hasDefault) delete row[spec.column];
    else row[spec.column] = "";
  } else {
    row[spec.column] = null;
  }
  return true;
}

/** Column metadata (notNull/hasDefault) for a table, or {} if unknown. */
function columnMetaFor(sqlName: string): Record<string, { notNull: boolean; hasDefault: boolean }> {
  const table = TABLE_BY_SQL_NAME.get(sqlName);
  if (!table) return {};
  const out: Record<string, { notNull: boolean; hasDefault: boolean }> = {};
  for (const [name, col] of Object.entries(getTableColumns(table))) {
    const c = col as { notNull?: boolean; hasDefault?: boolean };
    out[name] = { notNull: !!c.notNull, hasDefault: !!c.hasDefault };
  }
  return out;
}

// ─── dumpSubgraph ────────────────────────────────────────────────────────────

export async function dumpSubgraph(
  scope: SubgraphScope,
  opts: DumpOptions = {},
): Promise<DatabaseDump> {
  const tables: DatabaseDump["tables"] = {};
  const excludedTables = new Set(opts.excludeTables ?? []);

  // FK-resolution state — built as we walk parents, consumed by children.
  const idSets: Record<string, Set<string>> = {
    projectId: new Set<string>(),
    deploymentId: new Set<string>(),
    serviceId: new Set<string>(),
  };

  const collectIds = (rows: Array<Record<string, unknown>>, key: string) => {
    for (const r of rows) {
      const v = r["id"];
      if (typeof v === "string") idSets[key]!.add(v);
    }
  };

  for (const spec of TABLES) {
    if (excludedTables.has(spec.sqlName)) continue;
    const resolver = pickResolver(spec, scope);
    if (!resolver) {
      // Table not in this subgraph.
      continue;
    }

    let rows: Array<Record<string, unknown>>;
    if (resolver.via === "all-rows") {
      rows = (await db.select().from(spec.table)) as Array<Record<string, unknown>>;
    } else if (resolver.via === "root-project-id" && scope.kind === "project") {
      const idCol = (spec.table as unknown as { id: never }).id;
      rows = (await db
        .select()
        .from(spec.table)
        .where(eq(idCol, scope.projectId as never))) as Array<Record<string, unknown>>;
    } else if (resolver.via === "organizationId" && scope.kind === "organization") {
      const orgCol = (spec.table as unknown as { organizationId: never }).organizationId;
      rows = (await db
        .select()
        .from(spec.table)
        .where(eq(orgCol, scope.organizationId as never))) as Array<Record<string, unknown>>;
    } else if (resolver.via === "fk") {
      const parentIds = Array.from(idSets[resolver.column] ?? []);
      if (parentIds.length === 0) {
        rows = [];
      } else {
        const col = (spec.table as unknown as Record<string, never>)[resolver.column];
        rows = (await db.select().from(spec.table).where(inArray(col, parentIds))) as Array<
          Record<string, unknown>
        >;
      }
    } else if (resolver.via === "from-root-project" && scope.kind === "project") {
      // Look up the source column on the root project row, then select
      // THIS table by id = that value. Lets us bring along the project's
      // FK-target parents (e.g. project_app) without a separate pass.
      const idCol = (spec.table as unknown as { id: never }).id;
      const sourceCol = (schema.project as unknown as Record<string, never>)[resolver.sourceColumn];
      const sourceVals = (await db
        .select({ v: sourceCol })
        .from(schema.project)
        .where(eq(schema.project.id, scope.projectId as never))) as Array<{
        v: string | null;
      }>;
      const ids = sourceVals.map((r) => r.v).filter((v): v is string => typeof v === "string");
      if (ids.length === 0) {
        rows = [];
      } else {
        rows = (await db.select().from(spec.table).where(inArray(idCol, ids))) as Array<
          Record<string, unknown>
        >;
      }
    } else {
      rows = [];
    }

    tables[spec.sqlName] = rows;

    // Collect ids for FK-resolved children. Order of TABLES guarantees
    // parents come first.
    if (spec.sqlName === "project") collectIds(rows, "projectId");
    else if (spec.sqlName === "deployment") collectIds(rows, "deploymentId");
    else if (spec.sqlName === "service") collectIds(rows, "serviceId");
  }

  const strippedEncryptedFields = opts.stripEncrypted ? stripEncryptedInPlace(tables) : undefined;
  if (opts.stripInstanceRefs) stripInstanceRefsInPlace(tables);

  return {
    formatVersion: DUMP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceDriver: getDriver(),
    scope,
    tables,
    ...(strippedEncryptedFields ? { strippedEncryptedFields } : {}),
  };
}

/**
 * Lightweight row-count preview for an instance export. Unlike dumpSubgraph,
 * this never materializes row payloads or decrypts anything.
 */
export async function countInstanceSubgraphTables(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    TABLES.filter((spec) => spec.scopes.some((scope) => scope.in === "instance")).map(
      async (spec) => {
        const [row] = await db.select({ value: count() }).from(spec.table);
        return [spec.sqlName, Number(row?.value ?? 0)] as const;
      },
    ),
  );
  return Object.fromEntries(entries);
}

function pickResolver(spec: TableSpec, scope: SubgraphScope): ScopeResolver | null {
  for (const r of spec.scopes) {
    if (r.in === scope.kind) return r;
  }
  return null;
}

/**
 * Null every instance-scope FK reference across a dump's tables, in-place.
 *
 * Every column in INSTANCE_SCOPED_REFS is nullable in the schema (all five are
 * declared `.references(..., { onDelete: "set null" })`), so nulling is exactly what
 * the schema already says happens when the parent goes away — which, from the
 * destination instance's point of view, it has.
 *
 * Exported for testing and so a caller assembling a dump by other means can apply
 * the same rule.
 */
export function stripInstanceRefsInPlace(tables: DatabaseDump["tables"]): void {
  for (const [table, columns] of Object.entries(INSTANCE_SCOPED_REFS)) {
    const rows = tables[table];
    if (!rows || rows.length === 0) continue;
    for (const row of rows) {
      for (const col of columns) {
        if (row[col] != null) row[col] = null;
      }
    }
  }
}

/**
 * Redact every encrypted column across a dump's tables in-place, using the
 * NOT-NULL-safe rules (see redactEncryptedCell). Returns a per-column report.
 * Exported so the data-transfer export can strip ciphertext from the payload
 * AFTER it has extracted the plaintext into a separate passphrase-sealed bundle.
 */
export function stripEncryptedInPlace(
  tables: DatabaseDump["tables"],
): NonNullable<DatabaseDump["strippedEncryptedFields"]> {
  const out: NonNullable<DatabaseDump["strippedEncryptedFields"]> = [];
  const metaCache = new Map<string, Record<string, { notNull: boolean; hasDefault: boolean }>>();
  for (const spec of ENCRYPTED_COLUMNS) {
    const rows = tables[spec.table];
    if (!rows || rows.length === 0) continue;
    let columns = metaCache.get(spec.table);
    if (!columns) {
      columns = columnMetaFor(spec.table);
      metaCache.set(spec.table, columns);
    }
    let rowsAffected = 0;
    for (const row of rows) {
      if (redactEncryptedCell(row, spec, columns)) rowsAffected++;
    }
    if (rowsAffected > 0) out.push({ table: spec.table, column: spec.column, rowsAffected });
  }
  return out;
}

// ─── restoreSubgraph ─────────────────────────────────────────────────────────

export interface RestoreOptions {
  /**
   * wipe  — truncate every table in the dump's scope, then insert. Atomic
   *         (one transaction). FK checks are NOT deferred — see
   *         topoOrderedTables. Used by team-mode
   *         forward (Path A/B) and reverse migrations. Currently only
   *         supported for instance-scope dumps; org/project scope must
   *         use merge mode.
   * merge — insert only; pre-existing PKs surface as a thrown DB error
   *         and the whole transaction rolls back. Used by project-transfer
   *         (target should be empty of the project's rows; conflict means
   *         the caller has already transferred, or the slug collides).
   */
  mode: "wipe" | "merge";
  /**
   * When set, every row in a table with hasOrganizationId=true has its
   * organizationId rewritten to this value before INSERT. Used by cloud
   * ingest (remap to SaaS org) and project transfer (remap to target org).
   */
  remapOrgId?: string;
  /**
   * merge-mode only: tables listed here INSERT with onConflictDoNothing, so a
   * collision is silently skipped instead of aborting the whole transaction.
   * Used by instance-scope merge to preserve the destination's own singleton
   * + auth rows (instance_settings, user, organization, …) rather than fail on
   * their guaranteed PK collision.
   */
  mergeConflictSkip?: string[];
}

/**
 * Cross-tenant ingest guard for the REMAP path (cloud ingest + project transfer,
 * where `remapOrgId` rewrites organizationId on org-owned rows). A CHILD row's
 * parent FK (projectId / deploymentId / serviceId / groupId / destinationId /
 * runId / channelId) is NOT remapped, so a crafted dump could point e.g.
 * `service.projectId` at a VICTIM's project id and attach the row to another
 * tenant's project — cross-tenant write, and RCE via a planted
 * service.image/command or routing/SSL hijack via a planted domain (SaaS audit,
 * critical); or point `backup_run.destinationId` at a victim's backup
 * destination (→ their decrypted credentials adopted on restore). Require the
 * dump to be SELF-CONTAINED: every such FK must reference a parent row PRESENT
 * IN THE DUMP (which is org-remapped on insert), never a pre-existing row that
 * may belong to another tenant. dumpSubgraph always emits self-contained
 * subgraphs (tables whose NOT-NULL FK parent does not travel in a given scope —
 * e.g. notification_subscription.channelId, backup rows in project scope — are
 * excluded from that scope in TABLES), so legitimate transfers pass; a malicious
 * partial dump is rejected. Throws on the first violation. Exported for testing.
 * Pure — no DB access.
 */
export function assertDumpSelfContained(dump: DatabaseDump): void {
  // Column → parent table (sqlName). Every ownership/reference FK that a remap
  // leaves un-rewritten must be self-contained, or a crafted dump can attach a
  // remapped row to a pre-existing (cross-tenant) parent. Column names are
  // unambiguous across the schema, so a name→table map is sufficient.
  const FK_PARENT: Record<string, string> = {
    projectId: "project",
    deploymentId: "deployment",
    serviceId: "service",
    groupId: "project_app",
    // Backups: destinationId/runId reference org-scoped parents that DO travel
    // in an organization dump (backup_destination is org-shared, backup_run is
    // org-scoped), so a legitimate dump carries them and stays self-contained.
    // A crafted dump pointing destinationId at a VICTIM's backup_destination
    // (→ credential adoption on restore) or runId at a foreign run is rejected.
    destinationId: "backup_destination",
    runId: "backup_run",
    // Notifications: channelId references notification_channel, which is
    // INSTANCE-scope-only and never travels on a remap (org/project) dump, so
    // any channelId here could only be a pre-existing cross-tenant channel.
    // notification_subscription/notification_delivery are excluded from the
    // organization scope (see TABLES) so legit remap dumps never carry them;
    // this entry rejects such a row defensively if that scope is ever restored.
    channelId: "notification_channel",
    // route_rule.domainId — the only remappable-scope table that references a domain.
    // A project's rules only ever point at that project's own domains, which travel in
    // the same scope, so a legitimate dump is self-contained; a crafted one pointing at
    // a VICTIM's domain would otherwise attach a rate-limit / ban rule to their
    // hostname (traffic denial on someone else's site).
    domainId: "domain",
    // webhook_source / project_connection / personal_access_token_grant are
    // instance-scope only and never travel on a remap dump, so any value here could
    // only be a pre-existing cross-tenant parent. Rejected defensively, exactly as
    // channelId is.
    webhookSourceId: "webhook_source",
    sourceProjectId: "project",
    targetProjectId: "project",
    tokenId: "personal_access_token",
  };

  // Instance-scope parents (servers / mail_servers) NEVER travel in a remappable
  // scope, and `stripInstanceRefs` nulls their children's references on every
  // cross-instance dump — so on this path a non-null value cannot have come from a
  // legitimate transfer. Rejecting it closes the same attach-to-a-pre-existing-parent
  // shape the destinationId entry above describes, for the two columns it omitted:
  // a crafted dump could otherwise point backup_destination.serverId at a server row
  // that already exists on the receiver and have the restore adopt its SSH
  // credentials. Derived from INSTANCE_SCOPED_REFS so the scrub and this assert
  // cannot disagree about which columns are involved.
  const INSTANCE_REF_PARENT: Record<string, string> = {
    serverId: "servers",
    mailServerId: "mail_servers",
    forkMailServerId: "mail_servers",
  };
  for (const columns of Object.values(INSTANCE_SCOPED_REFS)) {
    for (const col of columns) {
      const parent = INSTANCE_REF_PARENT[col];
      if (parent) FK_PARENT[col] = parent;
    }
  }
  const dumpedIds: Record<string, Set<string>> = {};
  for (const [sqlName, rows] of Object.entries(dump.tables)) {
    if (!rows) continue;
    dumpedIds[sqlName] = new Set(
      rows
        .map((r) => (r as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string"),
    );
  }
  for (const [sqlName, rows] of Object.entries(dump.tables)) {
    if (!rows) continue;
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      for (const [col, parent] of Object.entries(FK_PARENT)) {
        const v = row[col];
        if (v == null) continue;
        if (!dumpedIds[parent]?.has(String(v))) {
          throw new Error(
            `restore rejected: ${sqlName}.${col}="${String(v)}" references a ${parent} not present in the dump — ` +
              `a remapped ingest may not attach rows to a pre-existing (cross-tenant) parent.`,
          );
        }
      }
    }
  }
}

/**
 * Restore using a caller-owned transaction. This is the composition point for
 * workflows that must commit follow-up writes (for example credential
 * re-encryption) atomically with the restored rows.
 */
export async function restoreSubgraphInTransaction(
  tx: DatabaseTransaction,
  dump: DatabaseDump,
  opts: RestoreOptions,
): Promise<void> {
  if (dump.formatVersion !== DUMP_FORMAT_VERSION) {
    throw new Error(
      `Dump format version ${dump.formatVersion} cannot be restored by this build (expected ${DUMP_FORMAT_VERSION}).`,
    );
  }

  // Remap path (cloud ingest / project transfer) is the only place an untrusted
  // caller supplies a dump for a DIFFERENT org — reject cross-tenant FKs there.
  if (opts.remapOrgId) assertDumpSelfContained(dump);

  // Kept for the day the schema declares its FKs DEFERRABLE — but DO NOT rely on
  // it. Postgres applies this only to constraints declared DEFERRABLE, and none of
  // ours are, so today it is a silent no-op. Correctness comes from
  // topoOrderedTables(), not from this line.
  await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

  if (opts.mode === "wipe") {
    // Engine-level last-resort gate: a whole-instance TRUNCATE must NEVER run
    // on the multi-tenant SaaS. The API route is unmounted in CLOUD_MODE and
    // exportInstance/importInstance refuse too, but this stops even a stray
    // in-process restoreSubgraph({mode:'wipe'}) from truncating every tenant if
    // those layers are ever bypassed. packages/db has no apps/api env → read raw.
    if (process.env.CLOUD_MODE === "true") {
      throw new Error(
        "Refusing a wipe restore on a multi-tenant (CLOUD_MODE) instance — this would truncate every tenant.",
      );
    }
    // Truncate only the tables this scope claims, in reverse order.
    // For project / organization scope we don't TRUNCATE because that
    // would wipe other tenants — `wipe` mode is conceptually a "this
    // scope only" wipe and the caller is responsible for ensuring the
    // dump covers every row in that scope. Today we only support wipe
    // for instance scope; org/project use merge.
    if (dump.scope.kind !== "instance") {
      throw new Error(
        `wipe mode is only supported for instance-scope dumps; got ${dump.scope.kind}.`,
      );
    }
    // Reverse of the derived insert order = children before parents.
    const reverse = [...topoOrderedTables()].reverse();
    for (const spec of reverse) {
      if (!pickResolver(spec, dump.scope)) continue;
      await tx.execute(
        sql`TRUNCATE TABLE ${sql.identifier(spec.sqlName)} RESTART IDENTITY CASCADE`,
      );
    }
  }

  // Pre-compute the encrypted-column specs keyed by table so the insert
  // loop below can redact those fields without re-scanning ENCRYPTED_COLUMNS
  // per row. Redaction on restore is REQUIRED (not optional like the
  // dump-side `stripEncrypted` flag): ciphertext from the wire was
  // encrypted under a foreign instance's BETTER_AUTH_SECRET, so we
  // could never decrypt it anyway, AND accepting it verbatim lets a
  // malicious caller plant arbitrary bytes in slots that downstream
  // code treats as "trusted encrypted blob" (env_var.value, notification
  // config, clone tokens, backup destination secrets, etc.). Always
  // redact these — receivers re-link credentials post-restore (the
  // data-transfer module re-hydrates them under the local key separately).
  const encryptedByTable = new Map<string, EncryptedColumnSpec[]>();
  for (const spec of ENCRYPTED_COLUMNS) {
    const list = encryptedByTable.get(spec.table) ?? [];
    list.push(spec);
    encryptedByTable.set(spec.table, list);
  }

  // Derived parent-before-child order — NOT `TABLES` order. See
  // topoOrderedTables: the FKs are not DEFERRABLE, so this is what keeps the
  // inserts legal.
  for (const spec of topoOrderedTables()) {
    if (!pickResolver(spec, dump.scope)) continue;
    const rows = dump.tables[spec.sqlName];
    if (!rows || rows.length === 0) continue;

    const encryptedCols = encryptedByTable.get(spec.sqlName);
    const colMeta = encryptedCols ? columnMetaFor(spec.sqlName) : {};

    // The set of columns THIS build's schema knows for the table. `prepared`
    // is filtered to it below so a version-skewed dump ingests cleanly:
    //   - sender NEWER than receiver → a column the receiver lacks would make
    //     Postgres reject the whole insert ("column X of relation Y does not
    //     exist"), because Drizzle derives the INSERT column list from the
    //     row's keys. Dropping the unknown key lets the row land (the receiver
    //     can't store what it doesn't model anyway).
    //   - sender OLDER than receiver → a column the receiver added is simply
    //     absent from the row; Drizzle emits DEFAULT for it. Safe ONLY if that
    //     column is nullable or has a default — the additive-migration rule.
    // This is the cross-version robustness that DUMP_FORMAT_VERSION (bumped
    // only on breaking shape changes) deliberately does not cover for plain
    // column additions.
    const columns = getTableColumns(spec.table);
    const knownCols = new Set(Object.keys(columns));

    // Timestamp/date columns arrive as ISO strings whenever the dump crossed
    // the wire as JSON (cloud ingest, project transfer) — JSON.stringify turns
    // a Date into a string, and Drizzle's timestamp mapToDriverValue then calls
    // `.toISOString()` on it and throws. Revive them to Date before insert.
    // (In-process restores keep real Dates and skip the `typeof === string`
    // branch, so this is a no-op there.)
    const dateCols = Object.entries(columns)
      .filter(([, col]) => (col as { dataType?: string }).dataType === "date")
      .map(([name]) => name);

    // Shallow-clone each row (filtered to known columns) so we don't mutate the
    // caller's input dump. redactEncryptedCell deep-clones any nested JSONB it
    // edits (secretPaths), so a top-level copy is enough here.
    const droppedCols = new Set<string>();
    const prepared = rows.map((r) => {
      const { row: next, dropped } = filterRowToKnownColumns(r, knownCols);
      for (const d of dropped) droppedCols.add(d);
      if (opts.remapOrgId && spec.hasOrganizationId) {
        next.organizationId = opts.remapOrgId;
      }
      if (encryptedCols) {
        for (const encSpec of encryptedCols) redactEncryptedCell(next, encSpec, colMeta);
      }
      for (const col of dateCols) {
        if (typeof next[col] === "string") next[col] = new Date(next[col] as string);
      }
      return next;
    });
    if (droppedCols.size > 0) {
      // Version skew, not a fault — the receiver's schema predates these
      // columns. Log once per table so it's diagnosable without failing.
      console.warn(
        `[restore] ${spec.sqlName}: dropped ${droppedCols.size} unknown column(s) not in this build's schema: ${[...droppedCols].join(", ")}`,
      );
    }

    // Shared parents (e.g. project_app, which owns many project environments
    // via the `from-root-project` resolver) may already exist on the target
    // — a re-promote re-supplies the same row, and inserting it again is a
    // no-op, not a conflict. Skip on conflict for those; and, in merge mode,
    // for tables the caller flagged as expected-to-collide (singleton/auth).
    // Every other table keeps strict insert so a real collision still
    // surfaces as PkCollision.
    const skipOnConflict =
      spec.scopes.some((s) => s.via === "from-root-project") ||
      (opts.mode === "merge" && !!opts.mergeConflictSkip?.includes(spec.sqlName));

    try {
      // Chunked: one INSERT per `insertChunkSize(spec.table)` rows, so a large
      // table cannot exceed the 65535 bind-parameter cap.
      const chunk = insertChunkSize(spec.table);
      for (let i = 0; i < prepared.length; i += chunk) {
        const batch = prepared.slice(i, i + chunk);
        if (skipOnConflict) {
          await tx
            .insert(spec.table)
            .values(batch as never)
            .onConflictDoNothing();
        } else {
          await tx.insert(spec.table).values(batch as never);
        }
      }
    } catch (err) {
      // PostgreSQL unique_violation = 23505 (PGlite mirrors this).
      // Surface as a typed error so callers (project transfer wizard,
      // cloud ingest) can distinguish "this row already exists on the
      // target" from a real server fault. The code lives on the driver
      // error, which Drizzle wraps — resolve it through the cause chain.
      const pg = resolvePgError(err);
      if (pg?.code === "23505") {
        throw new PkCollisionError(spec.sqlName, pg);
      }
      // Drizzle's top-level `.message` is only the "Failed query: … params:"
      // wrapper; the actual reason (column/constraint/detail) lives on the pg
      // cause. Re-throw with that reason in the message so it survives error
      // serialization to the transfer/ingest caller and reaches the operator,
      // instead of the useless wrapper. Keep the original as `cause`.
      if (pg) {
        const detail = (pg as { detail?: string }).detail;
        throw new Error(
          `restore ${spec.sqlName}: ${pg.message}${pg.code ? ` [${pg.code}]` : ""}${detail ? ` (${detail})` : ""}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
}

/** Restore a subgraph in one transaction. */
export async function restoreSubgraph(dump: DatabaseDump, opts: RestoreOptions): Promise<void> {
  await db.transaction(async (rawTx) => {
    await restoreSubgraphInTransaction(rawTx as DatabaseTransaction, dump, opts);
  });
}

/**
 * Delete a project's rows in child→parent FK order, inside one transaction.
 *
 * Scope note: this deletes every project-owned table INCLUDING `backup_policy`,
 * which a project-scope *dump* deliberately does NOT carry (backup tables FK to
 * the org-shared `backup_destination`). So on a bring-home wipe→restore cycle
 * the project's backup schedules are dropped and NOT re-created — the operator
 * re-binds a destination + re-creates schedules on the new host. This matches
 * the original inline bring-home wipe (behaviour preserved by the extraction).
 *
 * Deliberately does NOT touch `project_app`: that parent is shared across a
 * project's environments (many `project` rows → one app), so a project delete
 * must leave it, and `restoreSubgraph` re-inserts it idempotently.
 *
 * Single source of truth for "wipe one project's rows", used by the local
 * bring-home transfer AND the SaaS-side cloud teardown.
 */
export async function deleteProjectSubgraph(projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Resolve deployment ids first so service_deployment (FK → deployment) goes first.
    const deploymentRows = await tx
      .select({ id: schema.deployment.id })
      .from(schema.deployment)
      .where(eq(schema.deployment.projectId, projectId));
    const deploymentIds = deploymentRows.map((r) => r.id);
    if (deploymentIds.length > 0) {
      await tx
        .delete(schema.serviceDeployment)
        .where(inArray(schema.serviceDeployment.deploymentId, deploymentIds));
    }

    // Children before parents.
    await tx.delete(schema.service).where(eq(schema.service.projectId, projectId));
    await tx.delete(schema.domain).where(eq(schema.domain.projectId, projectId));
    await tx.delete(schema.envVar).where(eq(schema.envVar.projectId, projectId));
    await tx.delete(schema.backupPolicy).where(eq(schema.backupPolicy.projectId, projectId));
    await tx.delete(schema.deployment).where(eq(schema.deployment.projectId, projectId));
    await tx.delete(schema.project).where(eq(schema.project.id, projectId));
  });
}

// ─── Legacy shims ────────────────────────────────────────────────────────────
//
// Kept functional so external scripts and any in-flight callers keep
// working. New code should use dumpSubgraph / restoreSubgraph.

/** @deprecated Use dumpSubgraph({ kind: "instance" }, opts). */
export async function dumpDatabase(opts: DumpOptions = {}): Promise<DatabaseDump> {
  return dumpSubgraph({ kind: "instance" }, opts);
}

/** @deprecated Use restoreSubgraph(dump, { mode: wipeFirst ? "wipe" : "merge" }). */
export async function restoreDatabase(
  dump: DatabaseDump,
  opts: { wipeFirst?: boolean } = {},
): Promise<void> {
  return restoreSubgraph(dump, { mode: opts.wipeFirst ? "wipe" : "merge" });
}
