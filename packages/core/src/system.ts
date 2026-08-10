/**
 * System-wide limits, defaults, and operational constants.
 *
 * Every tunable value that governs system behaviour lives here.
 * Adapter-specific resource configs (CPU, memory, tiers) stay in @repo/adapters
 * because they're infrastructure-level. Everything else belongs here.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Import from anywhere:
 *   import { SYSTEM } from "@repo/core";
 *   if (count >= SYSTEM.PROJECTS.MAX_PER_USER) throw ...
 * ────────────────────────────────────────────────────────────────────────────
 */

export const SYSTEM = {
  // ── Projects ─────────────────────────────────────────────────────────
  PROJECTS: {
    /** Maximum projects a single user can own */
    MAX_PER_USER: 100,
    /** Maximum active (non-draft, non-deleted) projects per user */
    MAX_ACTIVE_PER_USER: 50,
    /** Default port for the app container */
    DEFAULT_PORT: 3000,
    /** Default git branch when none is specified */
    DEFAULT_BRANCH: "main",
    /** Default production mode */
    DEFAULT_PRODUCTION_MODE: "host" as const,
    /** Default framework when undetected */
    DEFAULT_FRAMEWORK: "unknown" as const,
    /** Default package manager */
    DEFAULT_PACKAGE_MANAGER: "npm" as const,
  },

  // ── Deployments / Builds ─────────────────────────────────────────────
  DEPLOYMENTS: {
    /** Max concurrent builds for the same project (prevents duplicate builds) */
    MAX_CONCURRENT_PER_PROJECT: 1,
    /** Max pending/queued sessions before rejecting new deployments */
    MAX_PENDING_SESSIONS: 5,
    /** Build session timeout in minutes (auto-fail after this) */
    BUILD_TIMEOUT_MINUTES: 30,
    /** Maximum length of the error message stored in DB */
    MAX_ERROR_MESSAGE_LENGTH: 512,
    /** Default restart policy for production containers */
    DEFAULT_RESTART_POLICY: "always" as const,
    /**
     * How long a just-started container is watched before a deploy may call
     * itself ready. Container-create succeeding proves nothing: a bad start
     * command exits within milliseconds and `restart: always` hides it behind a
     * bounce loop. Measured from each container's OWN start time, so a stack
     * whose earlier services have already been up this long waits only for the
     * last one.
     */
    STABILIZE_WINDOW_MS: 15_000,
    /** Inspect poll interval inside that window. */
    STABILIZE_POLL_MS: 1_000,
    /**
     * Restarts within the window that mean "crash loop" rather than "waited for
     * a dependency and recovered". Docker's restart backoff (100ms doubling)
     * takes an instantly-exiting process past this in ~2s, while a service that
     * times out waiting on a slow database manages one or two.
     */
    STABILIZE_CRASH_RESTARTS: 3,
    /** Log lines folded into the failure message, so diagnosing needs no SSH. */
    STABILIZE_LOG_TAIL_LINES: 20,
    /**
     * Readiness-probe budget when a project OPTS IN to the health check. Only
     * reached with `readiness.enabled` — an unconfigured deploy runs no probe
     * at all, so this never sits on the default critical path.
     */
    READINESS_TIMEOUT_MS: 45_000,
    /** Readiness-probe poll interval. */
    READINESS_INTERVAL_MS: 1_000,
  },

  // ── SSE / Build Streaming ────────────────────────────────────────────
  SSE: {
    /** Maximum log entries kept per build session */
    MAX_LOGS_PER_SESSION: 2000,
    /** Maximum concurrent SSE subscribers per session */
    MAX_SUBSCRIBERS_PER_SESSION: 5,
    /** How long a finished session stays in memory (seconds) */
    SESSION_TTL_SECONDS: 4 * 60 * 60, // 4 hours
    /** Keep-alive heartbeat interval (ms) - prevents proxy/CDN drops */
    HEARTBEAT_INTERVAL_MS: 25_000,
    /**
     * How long a finished handler waits for already-queued frames to flush
     * before the stream closes. Bounded because a client that has gone away
     * never drains, and that must not hold the response open.
     */
    TERMINAL_DRAIN_TIMEOUT_MS: 5_000,
    /** Maximum active sessions in the cache */
    MAX_SESSIONS: 500,
    /** Background sweep interval for stale sessions (ms) */
    SWEEP_INTERVAL_MS: 5 * 60 * 1000,
  },

  // ── Domains / SSL ────────────────────────────────────────────────────
  DOMAINS: {
    /** Free domain for cloud deployments (slug.CLOUD_DOMAIN) */
    CLOUD_DOMAIN: "opsh.io",
    /** Maximum custom domains per project */
    MAX_PER_PROJECT: 10,
    /** DNS TXT record prefix for domain verification */
    VERIFICATION_PREFIX: "_openship-challenge",
    /** SSL renewal scheduler interval (ms) */
    SSL_RENEW_INTERVAL_MS: 6 * 60 * 60 * 1000, // 6 hours
    /** How many days before expiry to trigger renewal */
    SSL_RENEW_BEFORE_DAYS: 14,
    /** Maximum domains to renew per scheduler run */
    SSL_RENEW_BATCH_SIZE: 50,
  },

  // ── Environment Variables ────────────────────────────────────────────
  ENV_VARS: {
    /** Maximum env vars per project per environment */
    MAX_PER_PROJECT: 100,
    /** Maximum key length */
    MAX_KEY_LENGTH: 256,
    /** Maximum value length */
    MAX_VALUE_LENGTH: 10_000,
  },

  // ── Validation ───────────────────────────────────────────────────────
  VALIDATION: {
    /** Maximum length for string fields (names, commands, etc.) */
    MAX_STRING_LENGTH: 500,
    /** Maximum project name length */
    MAX_PROJECT_NAME_LENGTH: 100,
    /** Maximum hostname length (RFC 1035) */
    MAX_HOSTNAME_LENGTH: 253,
    /** Port range */
    MIN_PORT: 1,
    MAX_PORT: 65535,
    // Resource bounds deliberately do NOT live here. They belong to
    // ./resources.ts, which is the single source of truth: the floors
    // (MIN_CPU_CORES / MIN_MEMORY_MB) plus the rule that the UPPER bound is the
    // target machine's probed capacity, not a constant. The unread
    // MAX_CPU_CORES: 4 / MAX_MEMORY_MB: 8192 pair that used to sit here encoded
    // exactly the fixed ceiling that made a large self-hosted box unusable.
    /** Pagination */
    DEFAULT_PAGE: 1,
    DEFAULT_PER_PAGE: 20,
    MAX_PER_PAGE: 100,
  },
} as const;
