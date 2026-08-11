import { pgTable, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── Servers ─────────────────────────────────────────────────────────────────

/**
 * SSH server configurations.
 *
 * One row per configured host. There's no kind / role flag - any server
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

  /** Human-readable label - defaults to sshHost when not set */
  name: text("name"),

  /**
   * True for the single auto-registered row that IS the OpenShip host (VPS /
   * server-host mode). Deploys to it run on the local host executor, not SSH.
   */
  isLocal: boolean("is_local").notNull().default(false),

  // ── SSH credentials ────────────────────────────────────────────────────────

  sshHost: text("ssh_host").notNull(),
  sshPort: integer("ssh_port").default(22),
  sshUser: text("ssh_user").default("root"),
  sshAuthMethod: text("ssh_auth_method"), // "password" | "key"
  sshPassword: text("ssh_password"),
  sshKeyPath: text("ssh_key_path"),
  sshKeyPassphrase: text("ssh_key_passphrase"),
  sshJumpHost: text("ssh_jump_host"),
  sshArgs: text("ssh_args"),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
