import { z } from "zod";
import { WORKLOAD_TYPES } from "../deployment-class";
import { RESOURCE_TIER_ORDER } from "../resources";

/**
 * Shape gate for `pricing.json` — the one editable source of every price,
 * allowance and limit Openship Cloud sells.
 *
 * The catalog is a COMMITTED file, not user input, so `parse` (throw) is the
 * right failure mode: a malformed edit must break the build everywhere rather
 * than silently degrade a price to `undefined` in a checkout call. The apps
 * catalog uses `safeParse` because it also ingests remote overlays; pricing has
 * no remote path.
 *
 * `null` means UNLIMITED on every numeric limit (`buildMinutesPerMonth`,
 * `freeSubdomains`, `seats`, `workspaces`, …) and NOT-PURCHASABLE on
 * `price.monthly`/`price.annual` (enterprise → contact sales). One rule, so a
 * reader never has to ask which flavour of null a field means.
 *
 * Stripe ids are stored as env-var NAMES (`stripePriceEnv`), never values: the
 * catalog is imported into browser bundles, and `process.env.STRIPE_*` read at
 * module load would both bundle a server concern into the client and freeze the
 * value at build time. `resolveStripePriceId()` reads the env at CALL time on
 * the server instead.
 */

/** Highest `schemaVersion` this build understands. */
export const MAX_SUPPORTED_PRICING_SCHEMA = 1;

/** A limit that may be "unlimited" (null). Non-negative integers only. */
const limitNumber = z.number().int().nonnegative().nullable();

/**
 * Limits are stated in the units a CUSTOMER can act on, and the Oblien ceilings
 * are derived from them (`toOblienLimits`) rather than authored separately.
 *
 * That direction is deliberate. Oblien's `resource_limits` are
 * `{max_workspaces, max_vcpus, max_ram_mb, max_disk_gb}`, and three of those four
 * are PER-WORKSPACE caps — only `max_workspaces` is namespace-wide. Authoring
 * them directly produced a catalog that read as a pool ("Pro: 16 vCPU") while
 * permitting 16 × 10 = 160 vCPU, and whose numbers matched nothing the deploy
 * wizard could actually select. Deriving instead means the published number and
 * the enforced number cannot drift, and the transient BUILD workspace is
 * accounted for by construction instead of 409-ing the free tier.
 */
const planLimitsSchema = z.object({
  /** Which deployment workloads the tier may run. Free ships `["static"]`. */
  workloads: z.array(z.enum(WORKLOAD_TYPES)).min(1),
  /** May the tier run multi-service stacks — Compose, catalog apps, managed DBs? */
  services: z.boolean(),
  /**
   * Concurrently running services — one Oblien workspace each. This is the
   * ceiling customers feel: an app + Postgres + Redis is 3, a static site is 0
   * at rest. Drives `max_workspaces` (plus build headroom).
   */
  runningServices: limitNumber,
  /** Projects (project groups). Oblien has no project concept — Openship gates it. */
  maxProjects: limitNumber,
  /**
   * The largest per-service machine this tier may select, named in the deploy
   * wizard's OWN vocabulary (`RESOURCE_TIER_SPECS`). Stating a raw vCPU number
   * here is what made the pricing page advertise sizes no picker offered.
   * `null` = uncapped (enterprise).
   */
  maxResourceTier: z.enum(RESOURCE_TIER_ORDER).nullable(),
  /**
   * App runtime included per month, in COMPUTE MINUTES — one minute of a `low`
   * machine. Bigger machines burn proportionally more (`computeUnitsPerMinute`:
   * medium 2×, high 4×, xlarge 8×), so one published number covers every size
   * without quoting a separate allowance per tier of machine.
   *
   * This replaced an authored `credits` blob whose numbers meant nothing: 60,000
   * credits against a 43,200-minute month, on a tier advertising 50 running
   * services — i.e. not enough to run ONE app around the clock. The unit now has
   * a definition, and `planMonthlyCredits()` derives the Oblien grant from it.
   *
   * `runningServices` is a CONCURRENCY cap, this is the METER. A tier may allow
   * more always-on apps than its minutes cover; that is what "up to" means and is
   * how metered compute works everywhere.
   *
   * 0 is meaningful and correct for a static-only tier: the edge serves static
   * sites, `runningServices` is already 0, so no app compute is consumed.
   */
  computeMinutesPerMonth: limitNumber,
  buildMinutesPerMonth: limitNumber,
  freeSubdomains: limitNumber,
  customDomains: limitNumber,
  seats: limitNumber,
});

const planSchema = z.object({
  id: z.string().min(1),
  price: z.object({
    /** USD cents, or null for "contact sales". */
    monthly: z.number().int().nonnegative().nullable(),
    annual: z.number().int().nonnegative().nullable(),
  }),
  stripePriceEnv: z.object({
    monthly: z.string().min(1).nullable(),
    annual: z.string().min(1).nullable(),
  }),
  popular: z.boolean(),
  contactSales: z.string().min(1).nullable(),
  support: z.enum(["community", "email", "priority", "dedicated"]),
  /** Tier whose features this one builds on — drives the "Everything in X" line. */
  inherits: z.string().min(1).optional(),
  limits: planLimitsSchema,
  /** Copy keys, in display order. Each must exist in `locales/en.json#features`. */
  features: z.array(z.string().min(1)).min(1),
});

/**
 * An instant, written as a full ISO-8601 timestamp WITH an offset.
 *
 * A bare `"2026-09-30"` is parsed as UTC midnight while `"2026-09-30T00:00:00"`
 * is parsed as LOCAL — the two are indistinguishable in a diff and differ by up
 * to a day depending on the container's timezone. A campaign written as a bare
 * date would also die at 00:00 ON the named day, silently losing its last day.
 * Requiring the offset removes the ambiguity instead of documenting it.
 */
const isoInstant = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    'must be a full ISO-8601 instant with an offset, e.g. "2026-09-30T23:59:59Z" — a bare date is timezone-ambiguous and ends a day early',
  )
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be a parseable date");

/**
 * A time-bounded price reduction — a launch offer, a seasonal promotion.
 *
 * Distinct from a promo CODE (see `apps/api/scripts/promo-code.ts`): a campaign
 * applies AUTOMATICALLY to everyone, with no code typed. Stripe enforces the
 * money via a coupon whose id comes from `stripeCouponEnv`; this entry is what
 * the UI displays and what checkout looks up.
 *
 * The two must agree, and nothing but a check can make them: `percentOff` here
 * is display, `coupon.percent_off` on Stripe is the charge. `verifyCampaigns()`
 * compares them so "50% off" on the page can't quietly bill 40%.
 *
 * NOTE Stripe cannot accept an automatic discount and a redeemable promo-code
 * field on the same Checkout Session — they are mutually exclusive at runtime.
 * While a campaign is live the code box is therefore hidden, so a campaign
 * should be at least as generous as any code already in circulation.
 */
const campaignSchema = z
  .object({
    id: z.string().min(1),
    /** Percent off the monthly price, 1–100. */
    percentOff: z.number().int().min(1).max(100),
    /** Plan ids the campaign applies to, or `"all"` for every purchasable tier. */
    appliesTo: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
    startsAt: isoInstant,
    endsAt: isoInstant,
    /** How many months the discount lasts per customer; null = for the whole
     *  subscription lifetime. Must match the Stripe coupon's duration. */
    durationMonths: z.number().int().positive().nullable(),
    /** Env var NAMING the Stripe coupon id — same indirection as price ids, so
     *  no live Stripe id is committed or shipped to a browser bundle. */
    stripeCouponEnv: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    if (Date.parse(c.endsAt) <= Date.parse(c.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: `campaign "${c.id}" ends before it starts` });
    }
  });

const creditPackSchema = z.object({
  id: z.string().min(1),
  creditsMilli: z.number().int().positive(),
  priceCents: z.number().int().positive(),
  stripePriceEnv: z.string().min(1),
  sortOrder: z.number().int(),
});

export const pricingCatalogSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    currency: z.string().length(3),
    /** Suffix of the managed free domain, e.g. `.opsh.io`. Copy interpolates it. */
    freeDomainSuffix: z.string().min(1),
    annual: z.object({
      /** False hides every annual affordance; annual prices may stay null. */
      enabled: z.boolean(),
      monthsFree: z.number().int().nonnegative(),
    }),
    /**
     * How customer-facing limits translate into Oblien's per-namespace ceilings.
     *
     * `buildResources` MIRRORS `DEFAULT_BUILD_RESOURCE_CONFIG` in adapters — a
     * build runs in its own Oblien workspace, and since `max_vcpus`/`max_ram_mb`/
     * `max_disk_gb` are per-workspace caps, a tier whose ceiling sits below the
     * build machine cannot build AT ALL (Oblien 409s the create). That is not
     * hypothetical: free published 2 vCPU / 2 GB against a 4 vCPU / 8 GB build,
     * so the one workload free is allowed to run would have failed the moment
     * ceilings went live. The mirror is asserted by test.
     *
     * `buildWorkspaceHeadroom` is how many transient build workspaces a tier may
     * hold ON TOP of its running services, because Oblien counts build
     * workspaces in `max_workspaces` too. Without it a free user with one
     * service could never deploy — the build would have nowhere to go.
     */
    oblien: z.object({
      buildWorkspaceHeadroom: z.number().int().nonnegative(),
      buildResources: z.object({
        cpuCores: z.number().positive(),
        memoryMb: z.number().int().positive(),
        diskGb: z.number().int().positive(),
      }),
    }),
    /** Time-bounded automatic discounts. Empty = list price. */
    campaigns: z.array(campaignSchema),
    plans: z.array(planSchema).min(1),
    creditPacks: z.array(creditPackSchema),
    /**
     * Copy for what EVERY cloud tier includes, stated once instead of repeated
     * down each column.
     *
     * This exists because the per-tier lists had become the differentiator, and
     * they were differentiating on nothing: the audit log, live logs and metrics
     * are ungated for everyone, so listing them only under Team implied a paywall
     * that no code enforces. A tier's bullets are now its NUMBERS; anything true
     * everywhere belongs here.
     *
     * Only put a key here that is actually shipped and reachable on cloud — the
     * defect this block replaces was advertising capability, not describing it.
     */
    standard: z.object({ features: z.array(z.string().min(1)).min(1) }),
    selfHosted: z.object({ features: z.array(z.string().min(1)).min(1) }),
  })
  .superRefine((data, ctx) => {
    if (data.schemaVersion > MAX_SUPPORTED_PRICING_SCHEMA) {
      ctx.addIssue({
        code: "custom",
        path: ["schemaVersion"],
        message: `pricing.json schemaVersion ${data.schemaVersion} is newer than this build supports (${MAX_SUPPORTED_PRICING_SCHEMA})`,
      });
    }

    const ids = new Set<string>();
    data.plans.forEach((plan, i) => {
      if (ids.has(plan.id)) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "id"], message: `duplicate plan id "${plan.id}"` });
      }
      ids.add(plan.id);
    });

    data.plans.forEach((plan, i) => {
      // `inherits` drives the "Everything in X" bullet, so a dangling id would
      // render an empty plan name mid-sentence.
      if (plan.inherits && !ids.has(plan.inherits)) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "inherits"], message: `plan "${plan.id}" inherits unknown plan "${plan.inherits}"` });
      }
      if (plan.inherits === plan.id) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "inherits"], message: `plan "${plan.id}" inherits itself` });
      }
      // A purchasable price with no Stripe env name can never reach checkout;
      // an env name with no price would render a free-looking paid tier.
      const monthlyPurchasable = plan.price.monthly !== null && plan.price.monthly > 0;
      if (monthlyPurchasable && !plan.stripePriceEnv.monthly) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "stripePriceEnv", "monthly"], message: `plan "${plan.id}" has a monthly price but no Stripe price env name` });
      }
      const annualPurchasable = plan.price.annual !== null && plan.price.annual > 0;
      if (annualPurchasable && !plan.stripePriceEnv.annual) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "stripePriceEnv", "annual"], message: `plan "${plan.id}" has an annual price but no Stripe price env name` });
      }
      // "Contact sales" and "has a price" are mutually exclusive: the UI keys
      // its whole CTA off which one is set.
      if (plan.contactSales && plan.price.monthly !== null) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "contactSales"], message: `plan "${plan.id}" sets contactSales but also a monthly price` });
      }
      if (!plan.contactSales && plan.price.monthly === null) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "price", "monthly"], message: `plan "${plan.id}" has no monthly price and no contactSales — it would render as an unbuyable blank` });
      }
      // The "Everything in X" bullet needs something to name.
      if (plan.features.includes("everythingIn") && !plan.inherits) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "features"], message: `plan "${plan.id}" uses the "everythingIn" feature key without an "inherits" tier` });
      }
    });

    const campaignIds = new Set<string>();
    data.campaigns.forEach((c, i) => {
      if (campaignIds.has(c.id)) {
        ctx.addIssue({ code: "custom", path: ["campaigns", i, "id"], message: `duplicate campaign id "${c.id}"` });
      }
      campaignIds.add(c.id);
      if (c.appliesTo !== "all") {
        for (const target of c.appliesTo) {
          if (!ids.has(target)) {
            ctx.addIssue({ code: "custom", path: ["campaigns", i, "appliesTo"], message: `campaign "${c.id}" targets unknown plan "${target}"` });
          }
        }
      }
    });

    // Two live campaigns overlapping in time on the same plan is ambiguous —
    // whichever the resolver picked first would win silently, and the page and
    // the Stripe coupon could disagree about which discount applied.
    for (let i = 0; i < data.campaigns.length; i++) {
      for (let j = i + 1; j < data.campaigns.length; j++) {
        const a = data.campaigns[i]!;
        const b = data.campaigns[j]!;
        const overlapsInTime =
          Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
        if (!overlapsInTime) continue;
        const sharesAPlan =
          a.appliesTo === "all" ||
          b.appliesTo === "all" ||
          a.appliesTo.some((p) => (b.appliesTo as string[]).includes(p));
        if (sharesAPlan) {
          ctx.addIssue({
            code: "custom",
            path: ["campaigns", j],
            message: `campaigns "${a.id}" and "${b.id}" overlap in time on the same plan — only one discount can apply`,
          });
        }
      }
    }

    const packIds = new Set<string>();
    data.creditPacks.forEach((pack, i) => {
      if (packIds.has(pack.id)) {
        ctx.addIssue({ code: "custom", path: ["creditPacks", i, "id"], message: `duplicate credit pack id "${pack.id}"` });
      }
      packIds.add(pack.id);
    });
  });

export type PricingCatalogRaw = z.infer<typeof pricingCatalogSchema>;
export type PricingPlanRaw = PricingCatalogRaw["plans"][number];
export type PricingCreditPackRaw = PricingCatalogRaw["creditPacks"][number];

/** Shape gate for a `locales/<lang>.json` copy file. Every leaf is a string;
 *  non-English files may be PARTIAL (missing keys deep-merge from English). */
export const pricingCopySchema = z.object({
  plans: z.record(z.string(), z.object({ name: z.string(), tagline: z.string() }).partial()).optional(),
  features: z.record(z.string(), z.string()).optional(),
  selfHosted: z
    .object({ name: z.string(), tagline: z.string(), priceLabel: z.string(), priceNote: z.string(), cta: z.string() })
    .partial()
    .optional(),
  creditPacks: z.record(z.string(), z.string()).optional(),
  ui: z
    .object({
      perMonth: z.string(),
      perYear: z.string(),
      custom: z.string(),
      free: z.string(),
      unlimited: z.string(),
      mostPopular: z.string(),
      monthsFree: z.string(),
      ctaStart: z.string(),
      ctaChoose: z.string(),
      ctaContact: z.string(),
      billedMonthly: z.string(),
      campaignBadge: z.string(),
      campaignEnds: z.string(),
      wasPrice: z.string(),
      /** Heading over the `standard.features` block. Lives here, not in an app
       *  dictionary, because the marketing site has no i18n framework. */
      standardTitle: z.string(),
      /** What a top-up pack buys, in recognisable units. Interpolates
       *  `{appHours}` and `{buildMinutes}`, both derived from the catalog. */
      creditPackNote: z.string(),
    })
    .partial()
    .optional(),
});
