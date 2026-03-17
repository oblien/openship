import {
  pgTable,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

// ─── Instance Settings ───────────────────────────────────────────────────────

/**
 * Machine-level configuration for this Openship installation.
 *
 * Single row — not per-user. Set by the desktop app (or installer) during
 * onboarding via the internal API. Covers SSH credentials, tunnel config,
 * and the default build mode for the instance.
 */
export const instanceSettings = pgTable("instance_settings", {
  id: text("id").primaryKey().default("default"), // single row

  /** Human-readable label — defaults to sshHost when not set */
  serverName: text("server_name"),

  // ── SSH credentials ────────────────────────────────────────────────────────

  sshHost: text("ssh_host"),
  sshPort: integer("ssh_port").default(22),
  sshUser: text("ssh_user").default("root"),
  sshAuthMethod: text("ssh_auth_method"), // "password" | "key"
  sshPassword: text("ssh_password"),
  sshKeyPath: text("ssh_key_path"),
  sshKeyPassphrase: text("ssh_key_passphrase"),
  sshJumpHost: text("ssh_jump_host"),
  sshArgs: text("ssh_args"),

  // ── Tunnel / connectivity ──────────────────────────────────────────────────

  /**
   * Tunnel provider:
   *   "edge"       → Openship Edge (zero-config, managed)
   *   "cloudflare" → Cloudflare Tunnel (user's account)
   *   "ngrok"      → ngrok tunnel
   *   null         → public IP, no tunnel needed
   */
  tunnelProvider: text("tunnel_provider"),
  tunnelToken: text("tunnel_token"),

  // ── Auth / mode ─────────────────────────────────────────────────────────────

  /**
   * Auth strategy for this instance:
   *   "none"  → zero-auth, auto-provisioned local user (desktop default)
   *   "cloud" → external auth on Openship Cloud (desktop + cloud)
   *   "local" → local Better Auth (self-hosted / SaaS)
   */
  authMode: text("auth_mode").notNull().default("none"),

  // ── Defaults ───────────────────────────────────────────────────────────────

  /** Default build mode for new users on this instance */
  defaultBuildMode: text("default_build_mode").notNull().default("auto"),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── User Platform Settings ──────────────────────────────────────────────────

/**
 * Per-user platform preferences — syncs across devices & to Openship Cloud.
 *
 * Each user gets one row (1:1 with `user`).
 * Build mode defaults to the instance default if not set.
 */
export const userSettings = pgTable("user_settings", {
  id: text("id").primaryKey(), // "us_..."
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),

  /**
   * Per-user build strategy override:
   *   "auto"   → use the stack's defaultBuildStrategy (smart per-framework)
   *   "server" → always build on the server
   *   "local"  → always build locally, transfer the output
   */
  buildMode: text("build_mode").notNull().default("auto"),

  /**
   * Encrypted session token for the user's Openship Cloud account.
   * Used by local instances to fetch namespace tokens from api.openship.io.
   * Null if the user hasn't linked their cloud account.
   */
  cloudSessionToken: text("cloud_session_token"),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
