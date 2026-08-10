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
/**
 * Openship's own DEPLOY-TIME readiness gate — the sibling of, and NOT the same
 * thing as, `ComposeHealthcheck` above.
 *
 *   ComposeHealthcheck  = the Docker HEALTHCHECK directive. An arbitrary command
 *                         ("pg_isready", "curl -f /health") that the DAEMON runs
 *                         on an interval, forever, to mark a container
 *                         healthy/unhealthy. Custom conditions, continuous.
 *   OpenshipReadiness   = "did this thing actually come up?", asked ONCE by the
 *                         deploy pipeline between "started" and "ready". A port
 *                         that accepts a connection (optionally an HTTP path that
 *                         answers < 500), a static site whose doc-root has a
 *                         servable index, and/or a container that didn't fall into
 *                         a restart loop. It is the only one that can hold up — or
 *                         veto — a deploy.
 *
 * EVERYTHING HERE IS OFF BY DEFAULT, and that is the point. Omit the block and a
 * deploy does no post-start waiting whatsoever: activate → route → ready. The
 * pipeline still runs *advisory* probes once the deploy is live (`auditPorts` →
 * `meta.portCheck`, `auditStaticOutput` → `meta.outputCheck`, both re-runnable on
 * demand), so "is it listening?" and "will it 404?" are answered without a gate
 * that can delay or fail a working deploy.
 *
 * Turn these on when you want the deploy itself to refuse to go green — e.g. a
 * release pipeline that must not advance on a broken build.
 *
 * Settable per PROJECT (the project's `readiness` column) and per compose SERVICE
 * (`service.advanced.readiness`, which overrides the project's for that service).
 */
export type OpenshipReadiness = {
  /**
   * Probe the workload after start and wait for it to answer — a port for a
   * running process, servable files for a static site. `false`/absent ⇒ no probe
   * is issued at all (the default).
   */
  enabled?: boolean;
  /**
   * Require an HTTP GET to this path to answer below 500. Omit to accept a bare
   * TCP connection, which also passes for non-HTTP services. Ignored by the
   * static-file probe, which checks the doc-root instead.
   */
  path?: string;
  /** Port to probe. Defaults to the workload's own port. */
  port?: number;
  /** How long to wait for the workload to answer. Default 45. */
  timeoutSeconds?: number;
  /**
   * Watch the container for a restart loop before reporting ready. Independent of
   * `enabled` — this reads the runtime (so it also covers remote/SSH targets)
   * rather than dialing anything. `false`/absent ⇒ not watched.
   */
  stabilization?: boolean;
  /** How long to watch for a restart loop. Default 15. */
  stabilizationSeconds?: number;
  /**
   * What a failed check does.
   *   "warn" (default) — the deploy stays `ready` and carries an
   *                      action-required warning. Never destroys anything.
   *   "fail"           — the deploy fails and reverts to the previous
   *                      deployment, which keeps serving.
   */
  onFailure?: OpenshipReadinessFailureAction;
};

export type OpenshipReadinessFailureAction = "warn" | "fail";

export const OPENSHIP_READINESS_FAILURE_ACTIONS: readonly OpenshipReadinessFailureAction[] = [
  "warn",
  "fail",
];

/**
 * `advanced` as sent on a WRITE, rather than as stored.
 *
 * Every key is additionally nullable because the server MERGES this onto the
 * stored blob instead of replacing it (`mergeAdvanced`, below):
 *   omitted → leave the stored value alone
 *   null    → remove that key
 * Replacing wholesale meant any caller that mentioned one key silently dropped the
 * others — and since the update route is MCP-exposed, an agent setting a
 * healthcheck would erase the readiness gate and an app template's config files.
 */
export type ComposeAdvancedPatch = {
  [K in keyof ComposeAdvanced]?: ComposeAdvanced[K] | null;
};

export type ComposeAdvanced = {
  healthcheck?: ComposeHealthcheck;
  /**
   * Per-service deploy-time readiness gate, overriding the project's for THIS
   * service. Absent ⇒ inherit the project's; neither ⇒ off.
   *
   * Distinct from `healthcheck` above in both what it asks and what it can do:
   * that one is a daemon-run custom command, this one is the pipeline's one-shot
   * "did it come up?" and is the only one that can fail a deploy.
   */
  readiness?: OpenshipReadiness;
  /**
   * Generated config files bind-mounted (read-only) into this service's
   * container at deploy — seeded from an app template's `files` (e.g. Kong's
   * `kong.yml`, Postgres init `.sql`). Content is resolved at install (generated
   * keys) with `{{publicUrl:…}}` left for deploy-time substitution. JSONB blob —
   * no migration.
   */
  files?: { path: string; content: string }[];
  /**
   * Per-service cpu/memory caps authored in the compose file, normalized from
   * either the short form (`mem_limit`, `cpus`) or the swarm form
   * (`deploy.resources.limits.{memory,cpus}`). These were silently dropped
   * before — an uploaded compose that asked for 4 GB still got the project-wide
   * value — so a service that declares its own limit now overrides the project
   * default at deploy time. `0`/absent = inherit the project (see
   * UNLIMITED_RESOURCES in ./resources).
   */
  resources?: { cpuCores?: number; memoryMb?: number };
  /**
   * Custom east-west DNS alias for this service, resolving ALONGSIDE the default
   * `service.name` on the project network — both names reach the container. Set
   * so another service can address this one by a stable, operator-chosen name
   * (e.g. `db` instead of `postgres-1`). Normalized with `normalizeServiceLabel`
   * before it reaches Docker; the single-app equivalent is `project.internal_alias`.
   * An alias existing is not exposure — publish stays loopback-only behind the edge.
   */
  alias?: string;
};

/**
 * Merge an incoming `advanced` patch onto what's stored, so a caller that mentions
 * one key can't erase the others.
 *
 * Semantics, mirroring how a JSON-merge patch behaves:
 *   key absent  → leave the stored value alone
 *   key = null  → remove it
 *   key present → replace that key outright (shallow — see the call site)
 *
 * Lives beside the type it operates on because @repo/db needs it too: the compose
 * sync in service.repo.ts writes this blob and cannot import from apps/api. It is
 * the only thing standing between a partial write and a silently-wiped readiness
 * gate, generated config files, or an east-west alias.
 */
export function mergeAdvanced(
  stored: ComposeAdvanced | null | undefined,
  incoming: unknown,
): ComposeAdvanced {
  const base: ComposeAdvanced = { ...(stored ?? {}) };
  // A non-object (or explicit null) `advanced` means "clear it" — the one way to
  // reset the whole blob, kept because that used to be the only behaviour.
  if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
    return incoming === undefined ? base : {};
  }
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (value === null) delete (base as Record<string, unknown>)[key];
    else if (value !== undefined) (base as Record<string, unknown>)[key] = value;
  }
  return base;
}

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
