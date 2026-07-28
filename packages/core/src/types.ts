/**
 * Shared TypeScript types used across apps and packages.
 */

/* ---------- Deployment ---------- */

export type DeploymentStatus =
  | "queued"
  | "building"
  | "deploying"
  | "ready"
  | "failed"
  | "cancelled";

export type Environment = "production" | "preview" | "development";

import type { StackId, Language } from "./stacks";

/** Framework / stack identifier - derived from STACKS registry */
export type Framework = StackId;

/** Programming language - derived from LANGUAGES registry */
export type LanguageId = Language;

/**
 * Package manager identifier.
 * JS has npm/yarn/pnpm/bun, Go has go, Rust has cargo, Python has pip/poetry/uv, etc.
 * Kept as a string (not union) because new package managers can be added to LANGUAGES.
 */
export type PackageManager = string;

export type ProductionMode = "host" | "static" | "standalone";

/**
 * Build strategy - where the build process runs.
 *   "server" → Build in the workspace/cloud (default)
 *   "local"  → Build on the host machine
 */
export type BuildStrategy = "server" | "local";

/**
 * Deploy target - where the application runs after build.
 *   "local"  → This machine (desktop/dev)
 *   "server" → User's remote server via SSH (selfhosted)
 *   "cloud"  → Oblien cloud workspace
 */
export type DeployTarget = "local" | "server" | "cloud";

/**
 * Runtime mode - how the application process is managed.
 *   "bare"   → Direct process on the host (pm2 / systemd / nohup)
 *   "docker" → Container-based via Docker daemon
 */
export type RuntimeMode = "bare" | "docker";

export type AdapterType = "docker" | "oblien";

export type SleepMode = "auto_sleep" | "always_on";

export type DomainStatus = "pending" | "active" | "failed" | "removing";

export type SslStatus = "none" | "provisioning" | "active" | "expired" | "error";

/* ---------- Billing ---------- */

export type PlanId = "free" | "pro" | "team";

export type SubscriptionStatus = "active" | "canceled" | "past_due";

export type UsageMetric = "build_minutes" | "bandwidth_gb" | "deployments";

/* ---------- Auth ---------- */

export type UserRole = "user" | "admin";

export type TeamRole = "owner" | "admin" | "member";

/* ---------- API Responses ---------- */

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  perPage: number;
}

/* ---------- Docker Compose ---------- */

/**
 * A container healthcheck as authored in compose (`services.<name>.healthcheck`),
 * shaped after the Docker Engine Healthcheck object. `test` is normalized to
 * either a shell string (compose `test: "curl ..."` / the `CMD-SHELL` array
 * form) or an argv array (the `CMD` array form). Durations stay as compose
 * strings ("30s", "1m30s") — the runtime converts them to nanoseconds at
 * container-create time. `disable` mirrors compose `healthcheck.disable: true`
 * (turns off an image's baked-in check → Docker `Test: ["NONE"]`).
 */
export type ComposeHealthcheck = {
  test?: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
  disable?: boolean;
};

/**
 * Extended compose fields that don't warrant their own first-class columns.
 * Stored as ONE JSONB blob (`service.advanced`) and nested inside the drift
 * `ComposeServiceSpec` so 3-way reconciliation covers it like any other
 * compose-owned field. Grows per phase (labels, entrypoint, extra_hosts, dns,
 * cap_add, …); because it's JSONB, every addition is a pure TS shape-widening —
 * no migration. Runtimes that can't honor a key (e.g. the cloud runtime for
 * host-level options) warn-and-drop rather than fail. Lives in @repo/core so
 * both @repo/db (storage) and @repo/adapters (runtime) can share one definition.
 */
export type ComposeAdvanced = {
  healthcheck?: ComposeHealthcheck;
  /**
   * Generated config files bind-mounted (read-only) into this service's
   * container at deploy — seeded from an app template's `files` (e.g. Kong's
   * `kong.yml`, Postgres init `.sql`). Content is resolved at install (generated
   * keys) with `{{publicUrl:…}}` left for deploy-time substitution. JSONB blob —
   * no migration.
   */
  files?: { path: string; content: string }[];
};

/**
 * Per-route edge rules (rate-limit, ban, allow/deny) enforced by the self-hosted
 * OpenResty guard. The DB `route_rule` table is the source of truth; the API
 * serializes this shape and pushes it into OpenResty's `rules` shared dict via
 * the mgmt API, where `rules_guard.lua` enforces it in the access phase — no
 * reload. Lives in @repo/core so @repo/db (storage) and @repo/adapters (runtime)
 * share one definition, like ComposeAdvanced above. Grows per phase (rewrites,
 * upstream/LB weights, …) as a pure shape-widening — no migration (JSONB).
 */
export type RouteRuleSpec = {
  /**
   * Per-client rate limit (fixed 1s window, keyed by client IP). Omit = unlimited.
   * `status` overrides the 429 response code. Runs alongside (does not replace)
   * the per-server nginx `limit_req` ceiling.
   */
  rateLimit?: { rps: number; burst: number; key?: "ip"; status?: number };
  /**
   * Blocklists → block (see `block.status`, default 403). `countries` = ISO
   * 3166-1 alpha-2 (bundled GeoIP). `userAgents` = case-insensitive substrings
   * (plain match, never a regex); `emptyUserAgent` blocks missing/blank UA.
   */
  ban?: {
    ips?: string[];
    cidrs?: string[];
    countries?: string[];
    userAgents?: string[];
    emptyUserAgent?: boolean;
  };
  /**
   * Allow/deny → block on a miss/deny. `allow*` are allow-lists (when non-empty,
   * ONLY matching clients pass); `denyCidrs` blocks. `methods` is an allow-list
   * of HTTP methods (others blocked). Country codes are ISO 3166-1 alpha-2.
   */
  access?: {
    allowCidrs?: string[];
    denyCidrs?: string[];
    allowCountries?: string[];
    methods?: string[];
  };
  /**
   * Hotlink protection: when `allowReferers` is non-empty, only requests whose
   * Referer host is listed pass. `allowEmpty` (default true) lets direct hits
   * (no/blank Referer) through — turn off to require a matching Referer.
   */
  hotlink?: { allowReferers?: string[]; allowEmpty?: boolean };
  /** Response code for access/ban/method/hotlink blocks. Default 403. */
  block?: { status?: number };
};
