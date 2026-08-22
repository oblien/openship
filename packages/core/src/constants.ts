/**
 * Shared constants used across the monorepo.
 */

export const APP_NAME = "Openship";

/**
 * Outbound links to our own properties — docs, support, community, socials.
 *
 * Shared because they're needed from places that can't import each other: the
 * dashboard's in-app help menu (React) and the desktop app's NATIVE application
 * menu (Electron main). They were literally the same five URLs typed twice, which
 * is how a docs link ends up dead in one menu and fine in the other.
 */
/**
 * Where our published images live when nothing overrides it.
 *
 * `OPENSHIP_IMAGE_REGISTRY` overrides it everywhere. Shared because the fallback
 * was typed independently in the CLI's compose generator, the API's edge-image
 * pin and the adapters' edge installer — three defaults that had to agree for a
 * pull to resolve, with nothing making them.
 *
 * NOTE: the shipped compose YAML repeats it as `${OPENSHIP_IMAGE_REGISTRY:-…}`
 * because compose interpolation can't read TypeScript. That copy is asserted
 * against this one by test.
 */
export const DEFAULT_IMAGE_REGISTRY = "ghcr.io/oblien";

export const BRAND_LINKS = {
  site: "https://openship.io",
  docs: "https://openship.io/docs",
  support: "https://openship.io/support",
  contact: "https://openship.io/contact",
  github: "https://github.com/oblien/openship",
  issues: "https://github.com/oblien/openship/issues/new",
  community: "https://discord.gg/Q9eWNCeXjg",
  x: "https://x.com/openship",
} as const;

export const DEPLOYMENT_STATUSES = [
  "queued",
  "building",
  "deploying",
  "ready",
  "failed",
  "cancelled",
] as const;

/**
 * Re-export from stacks registry - STACK_IDS replaces the old FRAMEWORKS array.
 * Import { STACK_IDS } or { STACKS } from "@repo/core" instead.
 */
export { STACK_IDS as FRAMEWORKS } from "./stacks";

export const PRODUCTION_MODES = ["host", "static", "standalone"] as const;

export const ENVIRONMENTS = ["production", "preview", "development"] as const;

export const DOMAIN_STATUSES = ["pending", "active", "failed", "removing"] as const;

export const SSL_STATUSES = ["none", "provisioning", "active", "expired", "error"] as const;

/**
 * Non-interactive environment variables injected into every build container.
 * Prevents interactive prompts and disables telemetry during CI builds.
 */
export const BUILD_ENV_VARS: Record<string, string> = {
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
  // Force color output even without a TTY (exec API uses pipes, not PTY)
  FORCE_COLOR: "1",
  TERM: "xterm-256color",
  // Framework telemetry
  NG_CLI_ANALYTICS: "false",
  NEXT_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  // Package manager
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  YARN_ENABLE_TELEMETRY: "0",
  PNPM_NO_UPDATE_NOTIFIER: "true",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Re-export from stacks registry - OUTPUT_DIRECTORIES is derived from STACKS.
 */
export { OUTPUT_DIRECTORIES } from "./stacks";

/**
 * Credit conversion rates: oblien raw unit → milli-credits.
 * Tune per resource type as pricing evolves.
 */
export const CREDIT_CONVERSION = {
  cpu_time_minutes: 500, // 1 cpu-min = 0.5 credit
  memory_gb_minutes: 100, // 1 GB-min RAM = 0.1 credit (~6 credits/GB-hr)
  disk_io_gb: 500, // 1 GB disk IO = 0.5 credit
  network_gb: 10_000, // 1 GB egress = 10 credits
  requests: 1, // 1 request = 0.001 credit (1k requests = 1 credit)
} as const;

/**
 * PLANS / PLAN_IDS / CREDIT_PACKS / PlanTierId / validatePlanPriceIds moved to
 * `./pricing` — every price, allowance and limit is now driven by the editable
 * `pricing.json` catalog and translated per locale, instead of being hardcoded
 * here. `@repo/core` re-exports them, so imports are unchanged.
 *
 * Two shapes DID change, deliberately, to make the old traps compile errors:
 *   - `PLANS[tier].stripePriceId` is gone. The catalog names the env VAR; call
 *     `resolveStripePriceId(tier, interval)` on the server, which reads the
 *     environment at call time. (The constant used to read `process.env` at
 *     module load — wrong in a browser bundle, and frozen at build time.)
 *   - `isPlaceholderPriceId` is gone with the `price_*_placeholder` defaults it
 *     existed to detect. An unset price id is now simply `null`.
 */


/**
 * #336: the sentinel a compose-service env value is masked to on API output.
 * Shared so the API (apps/api/src/lib/secret-env.ts) and the dashboard's env
 * editor agree on the EXACT string — the reveal + round-trip contract (a value
 * echoed back unchanged means "keep the stored secret") hinges on it, so the two
 * sides must never drift.
 */
export const ENV_MASK = "••••••••";
export const isMaskedValue = (value: unknown): boolean => value === ENV_MASK;

/**
 * Successful runs a backup policy keeps when it says nothing about retention.
 *
 * `retain_count` and `retain_days` were the only two fields on the policy insert
 * with no meaningful default and no column default, so every policy created
 * through the API stored NULL for both — and the prune short-circuits on
 * "no retention configured". Result: retention never ran for any API- or
 * MCP-created policy, and their runs grew until the destination filled.
 *
 * The value is the dashboard's own default (`PolicyEditor`'s `retainCount`
 * state), so the DB column default, the API fallback, and the form a human
 * actually sees all agree. Changing it here means changing all three at once —
 * which is the point. Existing NULL rows were backfilled by migration 0096.
 */
export const DEFAULT_RETAIN_COUNT = 7;

/**
 * Wall-clock time a backup runs when nobody picked one — the base for every
 * schedule derived from an app template (see `apps/backup-defaults.ts`).
 *
 * Same 03:17 the dashboard's schedule editor already offers as
 * `DEFAULT_BACKUP_TIME` (apps/dashboard/src/lib/backup-schedule.ts), so a policy
 * Openship derived and one a human clicked through the form land on the same
 * hour rather than looking like two different products. The minute is off :00
 * and :30 deliberately: those are where every hand-written cron in the world
 * piles up, and a dump is heavy enough that colliding with the rest of the box's
 * nightly work is worth one minute of avoidance.
 */
export const DEFAULT_BACKUP_HOUR = 3;
export const DEFAULT_BACKUP_MINUTE = 17;
