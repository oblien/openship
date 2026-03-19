import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// ─── Servers ─────────────────────────────────────────────────────────────────

/**
 * SSH server configurations for deployments.
 *
 * Multiple rows — one per configured server. Replaces the SSH fields
 * that were previously embedded in the singleton `instance_settings` row.
 */
export const servers = pgTable("servers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),

  /** Human-readable label — defaults to sshHost when not set */
  name: text("name"),

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
