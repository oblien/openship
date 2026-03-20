import {
  pgTable,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

// ─── Instance Settings ───────────────────────────────────────────────────────

/**
 * Machine-level configuration for this Openship installation.
 *
 * Single row — not per-user. Set by the desktop app (or installer) during
 * onboarding via the internal API.
 *
 * SSH server config lives in the `servers` table (single source of truth).
 * This table only stores instance-level preferences: auth strategy,
 * tunnel provider, and default build mode.
 */
export const instanceSettings = pgTable("instance_settings", {
  id: text("id").primaryKey().default("default"), // single row

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
  /** Default number of previous successful bare releases to retain for rollback */
  defaultRollbackWindow: integer("default_rollback_window").notNull().default(5),

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
