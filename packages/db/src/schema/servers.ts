import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, boolean, check } from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── Servers ─────────────────────────────────────────────────────────────────

/**
 * SSH server configurations.
 *
 * One row per configured host. `managementMode` separates deployment targets
 * from hosts connected only for inventory and monitoring. Observe-only rows
 * are never valid deployment or component-management targets.
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

  /** Human-readable label - defaults to sshHost when not set */
  name: text("name"),

  /**
   * True for the single auto-registered row that IS the OpenShip host (VPS /
   * server-host mode). Deploys to it run on the local host executor, not SSH.
   */
  isLocal: boolean("is_local").notNull().default(false),

  /**
   * `managed` hosts may receive deployments and OpenShip-managed components.
   * `observe_only` hosts remain reachable for read-only inventory/monitoring.
   */
  managementMode: text("management_mode", { enum: ["managed", "observe_only"] })
    .notNull()
    .default("managed"),

  // ── SSH credentials ────────────────────────────────────────────────────────

  sshHost: text("ssh_host").notNull(),
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

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  check("servers_ssh_transport_check", sql`${table.sshTransport} IN ('direct', 'cloudflare')`),
  check(
    "servers_management_mode_check",
    sql`${table.managementMode} IN ('managed', 'observe_only')`,
  ),
]);
