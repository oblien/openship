import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

// ─── Instance Settings ───────────────────────────────────────────────────────

/**
 * Machine-level configuration for this Openship installation.
 *
 * Single row - not per-user. Set by the desktop app (or installer) during
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

  /**
   * Source that drives `sendInvitationEmail` in `lib/auth.ts`:
   *   "platform" → use the provisioned mail server (preferSource="platform")
   *   "cloud"    → relay through Openship Cloud (stub today; falls back to
   *                env-based SMTP via lib/mail.ts until the cloud
   *                send-invitation endpoint exists)
   *
   * Default is "platform" — operators with a provisioned mail server
   * almost always want invites stamped with their own brand. Cloud-only
   * deployments can flip this to "cloud" to keep delivery routed
   * through the central relay.
   */
  invitationMailSource: text("invitation_mail_source")
    .notNull()
    .default("platform"),

  // ── Team-mode migration ────────────────────────────────────────────────────
  //
  // Tracks whether this instance has been migrated to a multi-user
  // deployment (operator's VPS or Openship Cloud). When non-default,
  // the dashboard becomes a launcher pointing at `migrationTargetUrl`
  // and the API only serves a minimal surface (auth + switch-back).
  //
  //   "single_user"          → default, normal operation
  //   "self_hosted_remote"   → migrated to operator's own VPS (URL set)
  //   "cloud_hosted"         → migrated to Openship Cloud (URL set)
  //   "tunneled"             → exposed via an Oblien edge tunnel routed at
  //                            this machine's dashboard port (no data move)
  //
  // Transitions are one-shot via the migration wizards. Reverse migration
  // back to single_user copies the data back and disconnects teammates.

  teamMode: text("team_mode").notNull().default("single_user"),
  /** Public URL where this instance now lives (null when teamMode='single_user'). */
  migrationTargetUrl: text("migration_target_url"),
  /**
   * For path A (self_hosted_remote): the server row id this instance
   * was migrated to. Needed by switch-back so we can SSH into the
   * right VPS to pull the latest dump back. Null for path B and
   * single_user.
   */
  migrationServerId: text("migration_server_id"),
  /** ISO timestamp of the migration (forensic). */
  migratedAt: timestamp("migrated_at"),
  /**
   * Oblien tunnel slug (the host portion, e.g. "myteam" for
   * "myteam.opsh.io" / "myteam-<suffix>.preview.oblien.com"). Set when
   * teamMode transitions through the tunneled path. Null otherwise.
   */
  tunnelSlug: text("tunnel_slug"),
  /**
   * Oblien-side tunnel id, retained so switch-back / update flows can
   * call Oblien's delete/update endpoints without re-resolving by slug.
   * Null when no tunnel has been provisioned for this instance.
   */
  tunnelId: text("tunnel_id"),

  /**
   * True while a migration is in flight (data is being dumped, shipped,
   * or restored). Refuses local mutations via migrationGuard middleware
   * to prevent writes from silently being lost or causing divergence
   * between this instance and the migration target. Cleared in the
   * finally block of withMigrationLock so the operator is never locked
   * out beyond the cutover window itself.
   */
  migrationInProgress: boolean("migration_in_progress").notNull().default(false),
  /**
   * When the current migration started. Lets the next acquire attempt
   * auto-recover a stale lock if a previous migration's process died
   * mid-flight (default stale threshold: 10 minutes). Null when no
   * migration is in flight.
   */
  migrationStartedAt: timestamp("migration_started_at"),

  // ── Email / SMTP transport ──────────────────────────────────────────────────
  //
  // Operator-configured SMTP used for ALL instance-sent mail — password reset,
  // email verification, team invites, and notifications. When set, this is the
  // highest-priority source in `lib/mail.ts` (above the provisioned mail-server
  // platform mailbox and the static env SMTP). Instance-wide, matching the auth
  // layer's scope. The password is encrypted at rest (`lib/encryption`) and is
  // NEVER returned to the client (masked on read). All-null = not configured.
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpUser: text("smtp_user"),
  smtpPasswordEncrypted: text("smtp_password_encrypted"),
  /** From header, e.g. "Openship <no-reply@example.com>". Falls back to smtpUser. */
  smtpFrom: text("smtp_from"),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── User Platform Settings ──────────────────────────────────────────────────

/**
 * Per-user platform preferences - syncs across devices & to Openship Cloud.
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
   * Default edge→app upstream strategy for new deploys: "auto" (→ loopback host
   * port), "loopback-port", or "container-ip" (advanced). Per-project +
   * per-deploy overrides win. Mirrors buildMode.
   */
  routeStrategy: text("route_strategy").notNull().default("auto"),

  /**
   * Encrypted session token for the user's Openship Cloud account.
   * Used by local instances to fetch namespace tokens from api.openship.io.
   * Null if the user hasn't linked their cloud account.
   */
  cloudSessionToken: text("cloud_session_token"),

  /**
   * Default deploy target seeded into new deployments:
   *   "local"  → this machine
   *   "server" → a configured server (pair with `defaultServerId`)
   *   "cloud"  → Openship Cloud
   *   null     → no preference, the deploy picker chooses (auto-selected
   *              when only one target is available)
   * The user can always override per-deployment from the picker on /deploy.
   */
  defaultDeployTarget: text("default_deploy_target"),

  /**
   * When defaultDeployTarget="server", the specific server to preselect.
   * Stored as a free-form text id (not FK) so that the row survives a
   * server deletion - the deploy picker just falls back to "no default"
   * when the id no longer resolves.
   */
  defaultServerId: text("default_server_id"),

  /* ── Clone credentials ────────────────────────────────────────────────────
   * User-level GitHub clone token (encrypted). The clone module reads this
   * AFTER per-project override and BEFORE the GitHub App installation token,
   * but only when `cloneTokenAsDefault === true`. Users set this in Settings
   * to keep a single PAT for everything.
   */
  cloneTokenEncrypted: text("clone_token_encrypted"),
  cloneTokenSetAt: timestamp("clone_token_set_at"),
  cloneTokenAsDefault: boolean("clone_token_as_default").notNull().default(false),

  /**
   * What the first-time deploy nudge resolved to. Once set to anything other
   * than "prompt", the nudge stops asking.
   *   "prompt"            → first deploy will show the picker
   *   "local"             → silently default unsafe combos to local build
   *   "remote-with-token" → user accepted the trade-off, ship token to remote
   */
  cloneStrategyPreference: text("clone_strategy_preference").notNull().default("prompt"),

  /**
   * Volume-transfer strategy for migrations / server-to-server moves.
   *   "auto"   → topology-aware (direct on same daemon, stream cross-host)
   *   "stream" → always tar-stream (streamPath → receiveStream)
   *   "direct" → single-helper same-daemon copy (falls back to stream cross-host)
   *   "rsync"  → reserved; falls back to stream until delta-rsync ships
   */
  transferMode: text("transfer_mode").notNull().default("auto"),
  /**
   * Compression for the stream path.
   *   "auto" → none on same host, gzip cross-host
   *   "zstd" | "gzip" | "none" → forced (zstd needs helper egress to fetch the codec)
   */
  transferCompression: text("transfer_compression").notNull().default("auto"),

  /**
   * Local-mode gh-CLI suppression. In `cli` auth mode the API falls back to
   * the host's `gh auth token` when no OAuth row is stored. That makes
   * Disconnect feel broken because gh silently re-authenticates. When this
   * flag is true the API treats gh CLI as if it isn't installed.
   */
  githubCliDisabled: boolean("github_cli_disabled").notNull().default(false),

  /**
   * Operator opt-in for the gh-CLI escape hatch. The gh CLI token is the
   * INSTANCE OPERATOR'S long-lived PAT (whatever user ran `gh auth login`
   * on the host). The previous "owner of any org gets to use it" gate
   * leaked that token across every org the operator joined later. This
   * flag is the explicit, per-user opt-in: only the user who flips it on
   * is treated as the operator, and only when env.GITHUB_AUTH_MODE === "cli"
   * (or auto-resolves to cli). Defaults to false so a fresh self-host
   * install cannot transitively grant gh-CLI access to non-operator users.
   */
  ghCliOperatorOptedIn: boolean("gh_cli_operator_opted_in").notNull().default(false),

  /**
   * Validated GitHub scope list captured at PAT save time via
   * `inspectPatScope`. Stored so we can re-check scope at use-time
   * without re-issuing `GET /user`. JSON array of OAuth scope strings
   * (e.g. ["repo", "workflow"]); null when no PAT is configured or
   * the inspection failed (legacy / pre-validation rows).
   */
  patScope: jsonb("pat_scope").$type<string[] | null>(),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
