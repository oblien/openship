import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, boolean, check, foreignKey, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { cloudWorkspace } from "./cloud-workspace";

// ─── Servers ─────────────────────────────────────────────────────────────────

/**
 * Execution hosts. Existing hosts use local/SSH connections; a workspace-bound
 * host uses the owning Cloud workspace's provider connection and runtime.
 *
 * One row per configured host. There's no workload role flag - any server
 * can host apps, the mail stack, or both. Whether mail is installed on a
 * given host is derived at runtime from the mail-state.json the install
 * pipeline writes, not from a schema column.
 *
 * The lone exception is `isLocal`: exactly one row (auto-created on boot when
 * OpenShip runs ON a server) represents the host OpenShip itself sits on. It is
 * resolved to the LOCAL host executor (createHostExecutor) instead of SSH, so
 * its ssh* fields are display placeholders and never dialed.
 */
export const servers = pgTable("servers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),

  organizationId: text("organization_id")
    .references(() => organization.id, { onDelete: "cascade" }),

  /** Managed host owner. Its subscription and provider VM lifecycle stay on the workspace. */
  workspaceId: text("workspace_id"),

  /** Import connections are never deployment destinations or general host controls. */
  purpose: text("purpose", { enum: ["deployment", "migration_source"] }).notNull().default("deployment"),

  /** Human-readable label - defaults to sshHost when not set */
  name: text("name"),

  /**
   * True for the single auto-registered row that IS the OpenShip host (VPS /
   * server-host mode). Deploys to it run on the local host executor, not SSH.
   */
  isLocal: boolean("is_local").notNull().default(false),

  // ── SSH credentials ────────────────────────────────────────────────────────

  sshHost: text("ssh_host"),
  sshPort: integer("ssh_port").default(22),
  sshUser: text("ssh_user").default("root"),
  sshAuthMethod: text("ssh_auth_method"), // "password" | "key"
  sshPassword: text("ssh_password"),
  sshKeyPath: text("ssh_key_path"),
  /**
   * Pasted/uploaded private-key material stored encrypted at rest (enc1:), for
   * when the key does NOT live on the API host — the common case on a remote /
   * VPS instance. Takes precedence over sshKeyPath in buildSshConfig. Write-only:
   * never serialized back to the client (see serializeServer).
   */
  sshPrivateKey: text("ssh_private_key"),
  sshKeyPassphrase: text("ssh_key_passphrase"),
  sshJumpHost: text("ssh_jump_host"),
  /** Transport is structured; arbitrary local ProxyCommand values are not stored. */
  sshTransport: text("ssh_transport", { enum: ["direct", "cloudflare"] }).notNull().default("direct"),
  sshArgs: text("ssh_args"),
  /** Public SSH host key pinned when a migration source is first connected. */
  sshHostKey: text("ssh_host_key"),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  check("servers_purpose_check", sql`${table.purpose} IN ('deployment', 'migration_source')`),
  check("servers_migration_source_check", sql`
    ${table.purpose} <> 'migration_source' OR (
      ${table.organizationId} IS NOT NULL AND ${table.workspaceId} IS NULL AND NOT ${table.isLocal}
      AND ${table.sshHost} IS NOT NULL AND ${table.sshHostKey} IS NOT NULL
      AND ${table.sshTransport} = 'direct' AND ${table.sshKeyPath} IS NULL
      AND ${table.sshJumpHost} IS NULL AND ${table.sshArgs} IS NULL
      AND ((${table.sshAuthMethod} = 'password' AND ${table.sshPassword} IS NOT NULL)
        OR (${table.sshAuthMethod} = 'key' AND ${table.sshPrivateKey} IS NOT NULL))
    )
  `),
  check("servers_ssh_transport_check", sql`${table.sshTransport} IN ('direct', 'cloudflare')`),
  uniqueIndex("servers_workspace_unique").on(table.workspaceId),
  uniqueIndex("servers_workspace_owner_unique").on(table.id, table.workspaceId, table.organizationId),
  foreignKey({
    name: "servers_workspace_owner_fk",
    columns: [table.workspaceId, table.organizationId],
    foreignColumns: [cloudWorkspace.id, cloudWorkspace.organizationId],
  }).onDelete("restrict"),
  check("servers_connection_check", sql`
    (${table.workspaceId} IS NULL AND ${table.sshHost} IS NOT NULL)
    OR (${table.workspaceId} IS NOT NULL AND ${table.organizationId} IS NOT NULL
      AND NOT ${table.isLocal} AND ${table.sshHost} IS NULL
      AND ${table.sshPassword} IS NULL AND ${table.sshKeyPath} IS NULL
      AND ${table.sshPrivateKey} IS NULL AND ${table.sshKeyPassphrase} IS NULL
      AND ${table.sshJumpHost} IS NULL AND ${table.sshArgs} IS NULL)
  `),
]);
