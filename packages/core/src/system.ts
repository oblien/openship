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
  },

  // ── SSE / Build Streaming ────────────────────────────────────────────
  SSE: {
    /** Maximum log entries kept per build session */
    MAX_LOGS_PER_SESSION: 2000,
    /** Maximum concurrent SSE subscribers per session */
    MAX_SUBSCRIBERS_PER_SESSION: 5,
    /** How long a finished session stays in memory (seconds) */
    SESSION_TTL_SECONDS: 4 * 60 * 60, // 4 hours
    /** Keep-alive heartbeat interval (ms) — prevents proxy/CDN drops */
    HEARTBEAT_INTERVAL_MS: 25_000,
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
    /** Resource limits */
    MIN_CPU_CORES: 0.25,
    MAX_CPU_CORES: 4,
    MIN_MEMORY_MB: 128,
    MAX_MEMORY_MB: 8192,
    /** Pagination */
    DEFAULT_PAGE: 1,
    DEFAULT_PER_PAGE: 20,
    MAX_PER_PAGE: 100,
  },
} as const;
