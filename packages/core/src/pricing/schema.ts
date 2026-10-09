import * as z from "zod";
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
export const MAX_SUPPORTED_PRICING_SCHEMA = 2;

/** A limit that may be "unlimited" (null). Non-negative integers only. */
const limitNumber = z.number().int().nonnegative().nullable();
const namespaceLimit = z.number().int().min(0).max(1_000_000_000).nullable();

/** App-level customer rules. Oblien's VM policy is declared separately below. */
export const planLimitsSchema = z.object({
  /** Which deployment workloads the tier may run. Free ships `["static"]`. */
  workloads: z.array(z.enum(WORKLOAD_TYPES)).min(1),
  /** May the tier run multi-service stacks — Compose, catalog apps, managed DBs? */
  services: z.boolean(),
  /**
   * Concurrent services across projects. Compose services share a workspace;
   * this app-level rule is independent of Oblien's workspace count.
   */
  runningServices: limitNumber,
  /** Projects (project groups). Oblien has no project concept — Openship gates it. */
  maxProjects: limitNumber,
  /** Preset ceiling for saved offers without explicit service resources. */
  maxResourceTier: z.enum(RESOURCE_TIER_ORDER).nullable(),
  /** CPU/RAM ceiling, including custom sizes. Absent on older paid snapshots. */
  maxServiceResources: z.object({
    cpuCores: z.number().finite().positive(),
    memoryMb: z.number().int().positive(),
  }).strict().nullable().optional(),
  /** Legacy display field. Paid offers leave it null: metered credits do not
   * imply a fixed number of runtime minutes. It never determines a credit grant. */
  computeMinutesPerMonth: limitNumber,
  buildMinutesPerMonth: limitNumber,
  freeSubdomains: limitNumber,
  // No finite admission gates exist for these fields yet. Do not sell a limit
  // that the application cannot enforce; current offers leave both uncapped.
  customDomains: z.null(),
  seats: z.null(),
});

const planSchema = z.object({
  id: z.string().min(1),
  price: z.object({
    /** USD cents, or null for "contact sales". */
    monthly: z.number().int().nonnegative().nullable(),
    annual: z.number().int().nonnegative().nullable(),
  }),
  /** Compute contract, independent of checkout copy and application limits. */
  billing: z
    .object({
      mode: z.enum(["metered", "monthly"]).default("metered"),
      creditsPerCycle: z.number().int().min(0).max(1_000_000_000).nullable(),
      yearlyCreditsPerCycle: z.number().int().min(1).max(1_000_000_000).nullable(),
      overdraft: z.number().int().min(0).max(1_000_000_000),
      suspendThreshold: z.number().int().min(0).max(1_000_000_000),
      onOverdraftAction: z.enum(["block", "stop_workspaces"]),
      /** VM ceilings and a separate total allocation for the namespace. */
      resourceLimits: z.object({
        max_workspaces: namespaceLimit,
        max_vcpus: namespaceLimit,
        max_ram_mb: namespaceLimit,
        max_disk_gb: namespaceLimit,
        max_total_vcpus: namespaceLimit,
        max_total_ram_mb: namespaceLimit,
        max_total_disk_gb: namespaceLimit,
      }).strict(),
      checkoutName: z.string().min(1).max(120).optional(),
      checkoutDescription: z.string().min(1).max(500).optional(),
    })
    .refine(
      (value) => value.suspendThreshold >= value.overdraft,
      "suspendThreshold must be at least overdraft",
    ),
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

const resourceRangeSchema = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive(),
  step: z.number().int().positive(),
}).strict().refine(range => range.max >= range.min && range.min % range.step === 0 && range.max % range.step === 0,
  "Resource bounds must be ordered and align with their step");

export const customPricingSchema = z.object({
  resources: z.object({
    cpuCores: resourceRangeSchema,
    memoryMb: resourceRangeSchema,
    diskGb: resourceRangeSchema,
  }).strict(),
  extraMonthlyCents: z.object({
    cpuCore: z.number().int().positive(),
    memoryGb: z.number().int().positive(),
    diskGb: z.number().int().positive(),
  }).strict(),
}).strict();

/** Openship resource access tiers, independent of monthly offers and usage rates.
 * Funding thresholds refer to verified credit purchases, never remaining balance. */
const paygPricingSchema = z.object({
  version: z.number().int().positive(),
  creditPackagesCents: z.array(z.number().int().positive()).min(1),
  tiers: z.array(z.object({
    id: z.string().regex(/^tier_[1-9]\d*$/),
    level: z.number().int().positive(),
    minimumFundingCents: z.number().int().positive(),
    pool: z.object({
      cpuCores: z.number().int().positive(),
      memoryMb: z.number().int().positive(),
      diskGb: z.number().int().positive(),
      servers: z.number().int().positive(),
    }).strict(),
  }).strict()).min(1),
}).strict();

/** Retail worker time, separate from app-server subscriptions and provider usage. */
const actionsPricingSchema = z.object({
  version: z.number().int().positive(),
  currency: z.literal("usd"),
  transferGiBPerDollar: z.number().int().positive(),
  depositsCents: z.array(z.number().int().min(100).max(100_000)).min(1),
  runners: z.array(z.object({
    id: z.string().regex(/^linux_[1-9]\d*$/),
    cpuCores: z.number().int().min(1).max(12),
    memoryMb: z.number().int().positive(),
    diskGb: z.number().int().positive(),
    /** Integer micro-USD per minute; converted to exact integer second units. */
    microUsdPerMinute: z.number().int().positive(),
  }).strict()).min(1),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.runners.map(runner => runner.id)).size !== value.runners.length)
    ctx.addIssue({ code: "custom", path: ["runners"], message: "Actions runner identities must be unique" });
  if (value.depositsCents.some((amount, index) => index > 0 && amount <= value.depositsCents[index - 1]!))
    ctx.addIssue({ code: "custom", path: ["depositsCents"], message: "Actions deposits must be unique and ascending" });
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
    /** Actual build-machine requests, independent of namespace policy. */
    oblien: z.object({
      buildResources: z.object({
        cpuCores: z.number().positive(),
        memoryMb: z.number().int().positive(),
        diskGb: z.number().int().positive(),
      }),
    }),
    /** Time-bounded automatic discounts. Empty = list price. */
    campaigns: z.array(campaignSchema),
    custom: customPricingSchema,
    payg: paygPricingSchema,
    actions: actionsPricingSchema,
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
    data.payg.tiers.forEach((tier, i) => {
      const previous = data.payg.tiers[i - 1];
      if (tier.level !== i + 1 || tier.id !== `tier_${tier.level}` ||
          (previous && (tier.minimumFundingCents <= previous.minimumFundingCents ||
            Object.keys(tier.pool).some(key => tier.pool[key as keyof typeof tier.pool] < previous.pool[key as keyof typeof tier.pool])))) {
        ctx.addIssue({ code: "custom", path: ["payg", "tiers", i], message: "PAYG tiers must have ordered identities, increasing funding thresholds and non-decreasing pools" });
      }
      if (tier.pool.memoryMb % 1024 !== 0 ||
          (["cpuCores", "memoryMb", "diskGb"] as const).some(key =>
            tier.pool[key] < data.custom.resources[key].min * tier.pool.servers)) {
        ctx.addIssue({ code: "custom", path: ["payg", "tiers", i, "pool"], message: "A PAYG pool must fit its advertised server count at the supported minimum size" });
      }
    });
    if (data.payg.creditPackagesCents.some((amount, i, amounts) => i > 0 && amount <= amounts[i - 1]!)) {
      ctx.addIssue({ code: "custom", path: ["payg", "creditPackagesCents"], message: "PAYG packages must be unique and ascending" });
    }
    data.plans.forEach((plan, i) => {
      if (ids.has(plan.id)) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "id"], message: `duplicate plan id "${plan.id}"` });
      }
      ids.add(plan.id);
    });

    const retailPlans = data.plans.filter(plan => (plan.price.monthly ?? 0) > 0 && !plan.contactSales);
    if (!retailPlans.length || retailPlans.some(plan => plan.billing.resourceLimits.max_workspaces !== 1)) {
      ctx.addIssue({ code: "custom", path: ["custom"], message: "Custom pricing requires single-server retail bundles" });
    }
    if (data.custom.resources.memoryMb.step % 1024 !== 0) {
      ctx.addIssue({ code: "custom", path: ["custom", "resources", "memoryMb"], message: "Custom memory increments must be whole GB" });
    }

    data.plans.forEach((plan, i) => {
      // `inherits` drives the "Everything in X" bullet, so a dangling id would
      // render an empty plan name mid-sentence.
      if (plan.inherits && !ids.has(plan.inherits)) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "inherits"], message: `plan "${plan.id}" inherits unknown plan "${plan.inherits}"` });
      }
      if (plan.inherits === plan.id) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "inherits"], message: `plan "${plan.id}" inherits itself` });
      }
      // Namespace offers use dynamic provider prices; no Stripe price ID is needed.
      const monthlyPurchasable = plan.price.monthly !== null && plan.price.monthly > 0;
      if (monthlyPurchasable && plan.billing.mode === "metered" && !plan.billing.creditsPerCycle) {
        ctx.addIssue({
          code: "custom",
          path: ["plans", i, "billing", "creditsPerCycle"],
          message: `plan "${plan.id}" needs a finite positive namespace allowance`,
        });
      }
      if (plan.billing.mode === "monthly" && (plan.billing.creditsPerCycle !== 0 ||
          plan.billing.yearlyCreditsPerCycle !== null || plan.price.annual !== null ||
          plan.billing.overdraft !== 0 || plan.billing.suspendThreshold !== 0)) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "billing"], message: "Monthly capacity has no credit allowance, overdraft or annual purchase" });
      }
      const annualPurchasable = plan.price.annual !== null && plan.price.annual > 0;
      // Oblien wallet funding is 100 credits/USD. Retail allowances must be
      // funded at list price; admin promotions record any deliberate subsidy.
      for (const [price, credits, field] of [[plan.price.monthly, plan.billing.creditsPerCycle, "creditsPerCycle"],
        [plan.price.annual, plan.billing.yearlyCreditsPerCycle, "yearlyCreditsPerCycle"]] as const) {
        if (price != null && price > 0 && credits != null && credits > price) {
          ctx.addIssue({ code: "custom", path: ["plans", i, "billing", field], message: "Namespace credits cannot exceed the wallet funding for this payment" });
        }
      }
      if (monthlyPurchasable && !plan.contactSales && Object.values(plan.billing.resourceLimits).some(value => value === null)) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "billing", "resourceLimits"], message: "Retail plans require explicit VM and total namespace capacity limits" });
      }
      const service = plan.limits.maxServiceResources;
      if (monthlyPurchasable && !plan.contactSales && !service) {
        ctx.addIssue({ code: "custom", path: ["plans", i, "limits", "maxServiceResources"], message: "Retail plans require explicit per-service CPU and memory limits" });
      }
      if (service) {
        const policy = plan.billing.resourceLimits;
        for (const [dimension, caps] of [
          ["cpuCores", [policy.max_vcpus, policy.max_total_vcpus]],
          ["memoryMb", [policy.max_ram_mb, policy.max_total_ram_mb]],
        ] as const) {
          if (caps.some(cap => cap !== null && service[dimension] > cap)) {
            ctx.addIssue({ code: "custom", path: ["plans", i, "limits", "maxServiceResources", dimension], message: "A service must fit within its workspace and shared capacity" });
          }
        }
      }
      if (annualPurchasable && !plan.billing.yearlyCreditsPerCycle) {
        ctx.addIssue({
          code: "custom",
          path: ["plans", i, "billing", "yearlyCreditsPerCycle"],
          message: `plan "${plan.id}" needs an explicit annual namespace allowance`,
        });
      }
      for (const amount of [plan.price.monthly, plan.price.annual]) {
        if (amount !== null && amount !== 0 && (amount < 100 || amount > 1_000_000)) {
          ctx.addIssue({
            code: "custom",
            path: ["plans", i, "price"],
            message: "Hosted offers require USD cents between 100 and 1000000",
          });
        }
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
    data.creditPacks.forEach((pack, i) => {
      if (pack.creditsMilli / 1000 > pack.priceCents) ctx.addIssue({ code: "custom", path: ["creditPacks", i],
        message: "Top-up credits cannot exceed the wallet funding for this payment" });
    });
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
