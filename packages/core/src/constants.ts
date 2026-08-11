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

export const ANNUAL_DISCOUNT = 0.2; // 20% off

/**
 * Plan tier identifier. Replaces the old PlanId union — kept here next to the
 * data so the type and the registry can't drift.
 */
export type PlanTierId = "free" | "pro" | "team" | "enterprise";

/**
 * Oblien per-workspace ceilings enforced at provision time. `null` means the
 * tier is custom (enterprise) and limits are negotiated per contract.
 */
export interface OblienLimits {
  max_workspaces: number;
  max_vcpus: number;
  max_ram_mb: number;
  max_disk_gb: number;
}

/**
 * A single plan tier. Prices are in cents; `null` price means "contact sales".
 * `monthlyCredits` is in milli-credits (1/1000 of a credit) so the engine can
 * meter sub-credit usage without floats. `null` credits means admin grants.
 */
export interface PlanDefinition {
  id: PlanTierId;
  name: string;
  description: string;
  price: { monthly: number | null; annual: number | null };
  stripePriceId: { monthly: string | null; annual: string | null };
  monthlyCredits: number | null;
  oblienLimits: OblienLimits | null;
  features: readonly string[];
  popular: boolean;
  support: string;
  contactSales?: string;
}

/**
 * A top-up credit pack. `credits_milli` is in milli-credits; `price_cents` is
 * USD cents charged via Stripe.
 */
export interface CreditPackDefinition {
  id: string;
  name: string;
  credits_milli: number;
  price_cents: number;
  stripePriceId: string;
  sortOrder: number;
}

export const PLANS: Record<PlanTierId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    description: "Get started for free",
    price: { monthly: 0, annual: 0 },
    stripePriceId: { monthly: null, annual: null },
    // Public dollar `price` on the paid tiers is `null` — the UI renders
    // "coming soon" and the Subscribe CTA stays disabled. Cloud pricing is
    // intentionally NOT published yet. `monthlyCredits` (the CPU-time/credit
    // quota pushed to Oblien) is real so tiers still enforce — it's an internal
    // number, never shown as a price. NOTE (tune before launch): these credit
    // numbers are placeholders sized to Oblien's 10,000,000-credit ceiling; the
    // true credit-per-$/per-cpu-minute rate is Oblien-configured. 1 openship
    // credit = 1 Oblien credit = 1000 milli (the wrapper divides by 1000 at the
    // Oblien boundary). Self-hosted is free and surfaces none of these numbers.
    monthlyCredits: 500_000, // 500 credits — free-tier allowance
    oblienLimits: {
      max_workspaces: 1,
      max_vcpus: 2,
      max_ram_mb: 2048,
      max_disk_gb: 10,
    },
    features: [
      "1 workspace",
      "Community support",
    ],
    popular: false,
    support: "community",
  },
  pro: {
    id: "pro",
    name: "Pro",
    description: "For solo builders shipping production workloads",
    price: { monthly: null, annual: null }, // coming soon — pricing not published
    stripePriceId: {
      monthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? "price_pro_monthly_placeholder",
      annual: process.env.STRIPE_PRICE_PRO_ANNUAL ?? "price_pro_annual_placeholder",
    },
    monthlyCredits: 10_000_000, // 10,000 credits/mo (placeholder — tune before launch)
    oblienLimits: {
      max_workspaces: 10,
      max_vcpus: 16,
      max_ram_mb: 32768,
      max_disk_gb: 100,
    },
    features: [
      "Up to 10 workspaces",
      "Email support",
    ],
    popular: true,
    support: "email",
  },
  team: {
    id: "team",
    name: "Team",
    description: "For teams collaborating on shared infra",
    price: { monthly: null, annual: null }, // coming soon — pricing not published
    stripePriceId: {
      monthly: process.env.STRIPE_PRICE_TEAM_MONTHLY ?? "price_team_monthly_placeholder",
      annual: process.env.STRIPE_PRICE_TEAM_ANNUAL ?? "price_team_annual_placeholder",
    },
    monthlyCredits: 60_000_000, // 60,000 credits/mo (placeholder — tune before launch)
    oblienLimits: {
      max_workspaces: 50,
      max_vcpus: 64,
      max_ram_mb: 131072,
      max_disk_gb: 500,
    },
    features: [
      "Up to 50 workspaces",
      "Team collaboration",
      "Priority email support",
    ],
    popular: false,
    support: "priority email",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    description: "Custom limits, SLAs, dedicated infra",
    price: { monthly: null, annual: null }, // contact sales
    stripePriceId: { monthly: null, annual: null },
    monthlyCredits: null, // admin grants
    oblienLimits: null, // custom per contract
    features: [
      "Custom credit allocation",
      "Custom workspace limits",
      "SSO / SAML",
      "Dedicated support & SLA",
    ],
    popular: false,
    support: "dedicated",
    contactSales: "mailto:sales@openship.io",
  },
};

/** Ordered list of plan IDs for display. */
export const PLAN_IDS: readonly PlanTierId[] = [
  "free",
  "pro",
  "team",
  "enterprise",
] as const;

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
 * Top-up packs catalog (kept in code, synced to credit_pack table at boot).
 */
export const CREDIT_PACKS: readonly CreditPackDefinition[] = [
  {
    id: "pack_5k",
    name: "5,000 credits",
    credits_milli: 5_000_000,
    price_cents: 500,
    stripePriceId: process.env.STRIPE_PRICE_PACK_5K ?? "price_pack_5k_placeholder",
    sortOrder: 10,
  },
  {
    id: "pack_25k",
    name: "25,000 credits",
    credits_milli: 25_000_000,
    price_cents: 2000,
    stripePriceId: process.env.STRIPE_PRICE_PACK_25K ?? "price_pack_25k_placeholder",
    sortOrder: 20,
  },
  {
    id: "pack_100k",
    name: "100,000 credits",
    credits_milli: 100_000_000,
    price_cents: 7000,
    stripePriceId: process.env.STRIPE_PRICE_PACK_100K ?? "price_pack_100k_placeholder",
    sortOrder: 30,
  },
] as const;

/**
 * Returns true when `priceId` is one of the placeholder values minted
 * by the env-default fallbacks above (e.g. `price_pro_monthly_placeholder`).
 * Used both at boot (fail closed in CLOUD_MODE) and at checkout
 * (defense in depth — placeholders cannot reach Stripe).
 */
export function isPlaceholderPriceId(priceId: string | null | undefined): boolean {
  if (!priceId) return false;
  return /placeholder/i.test(priceId);
}

/**
 * Boot-time validation of plan + pack Stripe price ids. Returns a list
 * of the "missing" labels (e.g. "pro.monthly", "team.annual",
 * "pack_5k") that are still set to their placeholder defaults.
 *
 * CLOUD_MODE callers should treat a non-empty result as fatal at boot
 * — billing flows would otherwise reach Stripe with bogus price ids
 * and fail with cryptic Stripe-side errors. Self-hosted callers may
 * choose to log-and-continue since billing is disabled on that path.
 */
export interface PlanPriceIdValidation {
  missing: string[];
}

export function validatePlanPriceIds(): PlanPriceIdValidation {
  const missing: string[] = [];

  for (const tier of ["pro", "team"] as const) {
    const p = PLANS[tier];
    for (const interval of ["monthly", "annual"] as const) {
      if (isPlaceholderPriceId(p.stripePriceId[interval])) {
        missing.push(`${tier}.${interval}`);
      }
    }
  }

  for (const pack of CREDIT_PACKS) {
    if (isPlaceholderPriceId(pack.stripePriceId)) {
      missing.push(pack.id);
    }
  }

  return { missing };
}

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
