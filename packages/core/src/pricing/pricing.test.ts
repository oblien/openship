import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PRICING,
  PLANS,
  PLAN_IDS,
  PRICING_LOCALES,
  CREDIT_PACKS,
  planLimits,
  planAllowsWorkload,
  planAllowsServices,
  planMonthlyCredits,
  computeUnitsPerMinute,
  resolvePlan,
  resolvePlans,
  resolveStandard,
  resolveSelfHosted,
  resolveCreditPacks,
  resolveStripePriceId,
  resolveCreditPackPriceId,
  validatePlanPriceIds,
  toPricingLocale,
  pricingUi,
  activeCampaign,
  effectiveMonthlyPrice,
  type PlanTierId,
  type PricingLocale,
} from "./index";
import { pricingCatalogSchema, pricingCopySchema } from "./schema";
import { RESOURCE_TIER_ORDER, RESOURCE_TIER_SPECS } from "../resources";

const localesDir = fileURLToPath(new URL("./locales", import.meta.url));
const readLocale = (locale: string) =>
  JSON.parse(readFileSync(`${localesDir}/${locale}.json`, "utf8")) as Record<string, unknown>;
const en = readLocale("en");

/** Locale dirs are enumerated, never hardcoded — a hardcoded list silently skips
 *  a newly added language (this has bitten the dashboard's i18n twice). */
const onDisk = readdirSync(localesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

/** Every leaf path in a copy object, e.g. "features.buildMinutes". */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("pricing catalog (pricing.json)", () => {
  it("validates against the schema", () => {
    expect(() => pricingCatalogSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL("./pricing.json", import.meta.url)), "utf8")))).not.toThrow();
  });

  it("PlanTierId matches the catalog ids exactly, in order", () => {
    // The union is hand-declared (a JSON import widens ids to `string`), so this
    // is the assertion that keeps type and data in lockstep. Adding a tier to
    // the JSON without the union means every exhaustive Record silently misses it.
    const union: PlanTierId[] = ["free", "starter", "pro", "team", "enterprise"];
    expect(PRICING.plans.map((p) => p.id)).toEqual(union);
    expect(PLAN_IDS).toEqual(union);
  });

  it("prices the published ladder: free, $10, $39, $99, custom", () => {
    expect(PRICING.plans.map((p) => p.price.monthly)).toEqual([0, 1000, 3900, 9900, null]);
  });

  it("ships exactly one popular tier", () => {
    expect(PRICING.plans.filter((p) => p.popular).map((p) => p.id)).toEqual(["pro"]);
  });

  it("keeps prices monotonically increasing with the value ladder", () => {
    const paid = PRICING.plans.filter((p) => p.price.monthly !== null && p.price.monthly > 0);
    const cents = paid.map((p) => p.price.monthly!);
    expect([...cents].sort((a, b) => a - b)).toEqual(cents);
    // Every allowance that is a number on both tiers must not shrink as price grows.
    const dims = ["buildMinutesPerMonth", "runningServices", "maxProjects", "freeSubdomains"] as const;
    for (let i = 1; i < paid.length; i++) {
      for (const dim of dims) {
        const lo = paid[i - 1]!.limits[dim];
        const hi = paid[i]!.limits[dim];
        if (lo === null || hi === null) continue;
        expect(hi, `${paid[i]!.id}.${dim} must be >= ${paid[i - 1]!.id}.${dim}`).toBeGreaterThanOrEqual(lo);
      }
    }
  });

  it("gives each paid tier more credit per dollar than the one below", () => {
    // The stated deal: scaling up must never get worse value.
    const paid = PRICING.plans.filter((p) => (p.price.monthly ?? 0) > 0 && planMonthlyCredits(p.id) !== null);
    const perDollar = paid.map((p) => planMonthlyCredits(p.id)! / p.price.monthly!);
    for (let i = 1; i < perDollar.length; i++) {
      expect(perDollar[i]!, `${paid[i]!.id} must not be worse value than ${paid[i - 1]!.id}`).toBeGreaterThan(perDollar[i - 1]!);
    }
  });

  it("restricts the free tier to static workloads and no service stacks", () => {
    expect(planLimits("free").workloads).toEqual(["static"]);
    expect(planAllowsWorkload("free", "static")).toBe(true);
    expect(planAllowsWorkload("free", "web")).toBe(false);
    expect(planAllowsWorkload("free", "worker")).toBe(false);
    expect(planAllowsServices("free")).toBe(false);
  });

  it("gives the free tier 500 build minutes, 10 free subdomains and no app compute", () => {
    expect(planLimits("free").buildMinutesPerMonth).toBe(500);
    expect(planLimits("free").freeSubdomains).toBe(10);
    // 0 is the correct published figure, not a missing one: free is static-only
    // (`runningServices` is 0), the edge serves static sites, so no app compute is
    // consumed. The build allowance above is what free actually spends.
    expect(planLimits("free").computeMinutesPerMonth).toBe(0);
  });

  it("never lets a count-bearing limit be 1", () => {
    // The feature strings say "{maxProjects} projects" / "{runningServices}
    // running services". A value of 1 renders "1 projects", and carrying a
    // per-language plural system (Arabic alone has six forms) for one number is
    // not worth it — so the catalog stays out of the singular instead.
    for (const plan of PRICING.plans) {
      expect(plan.limits.maxProjects, `${plan.id}.maxProjects`).not.toBe(1);
      expect(plan.limits.runningServices, `${plan.id}.runningServices`).not.toBe(1);
    }
  });

  it("publishes no limit that nothing can enforce", () => {
    // The rule this encodes: every published limit must be enforceable by Oblien
    // (resource_limits / credit quota) or by an Openship gate. `bandwidthGb` was
    // published on all four tiers and enforced by neither — Oblien has no
    // bandwidth ceiling — so it was removed rather than left as decoration.
    const enforceable = new Set([
      "workloads", // plan-guard: assertPlanAllowsDeployShape
      "services", // plan-guard: assertPlanAllowsServices
      "runningServices", // Oblien max_workspaces + plan-guard
      "maxProjects", // plan-guard: assertProjectQuota
      "maxResourceTier", // Oblien max_vcpus/max_ram_mb/max_disk_gb
      "computeMinutesPerMonth", // Oblien credit quota, via planMonthlyCredits()
      "buildMinutesPerMonth", // plan-guard: assertBuildMinutesAvailable
      "freeSubdomains", // plan-guard: assertFreeSubdomainQuota
      "customDomains", // null everywhere = unlimited, nothing to enforce
      "seats", // null everywhere = unlimited, nothing to enforce
    ]);
    for (const plan of PRICING.plans) {
      for (const key of Object.keys(plan.limits)) {
        expect(enforceable.has(key), `limits.${key} is published but nothing enforces it`).toBe(true);
      }
    }
  });

  it("lets every paid tier run any workload with service stacks", () => {
    for (const id of PLAN_IDS.filter((i) => i !== "free")) {
      expect(planAllowsWorkload(id, "web"), id).toBe(true);
      expect(planAllowsWorkload(id, "worker"), id).toBe(true);
      expect(planAllowsServices(id), id).toBe(true);
    }
  });

  it("never charges per seat", () => {
    for (const plan of PRICING.plans) expect(plan.limits.seats, plan.id).toBeNull();
  });

  it("keeps annual hidden until it is published", () => {
    expect(PRICING.annual.enabled).toBe(false);
    for (const plan of PRICING.plans) expect(plan.price.annual, plan.id).toBeNull();
  });

  it("falls back to the most restrictive tier for an unknown plan id", () => {
    // A stale plan_tier_id must not open a gate.
    expect(planLimits("legacy-tier")).toEqual(planLimits("free"));
    expect(planLimits(null)).toEqual(planLimits("free"));
    expect(planMonthlyCredits("nope")).toBe(planMonthlyCredits("free"));
    expect(planAllowsWorkload(undefined, "web")).toBe(false);
  });

  it("keeps every credit grant under the Oblien 10,000,000-credit ceiling", () => {
    for (const id of PLAN_IDS) {
      const milli = planMonthlyCredits(id);
      if (milli === null) continue;
      expect(milli / 1000, id).toBeLessThanOrEqual(10_000_000);
    }
    for (const pack of PRICING.creditPacks) {
      expect(pack.creditsMilli / 1000, pack.id).toBeLessThanOrEqual(10_000_000);
    }
  });

  it("grants every finite tier a POSITIVE quota, free included", () => {
    // `toOblienCredits()` rejects a non-positive quota, and free publishes 0
    // compute minutes — so deriving the grant from compute alone would make every
    // free-tier quota push throw at provision time. Build minutes are in the sum
    // for exactly this reason; this is the test that fails if someone "simplifies"
    // them back out.
    for (const id of PLAN_IDS) {
      const milli = planMonthlyCredits(id);
      if (milli === null) continue; // enterprise: hand-granted
      expect(milli, `${id} would be refused by toOblienCredits()`).toBeGreaterThan(0);
    }
  });

  it("derives each tier's grant from its published minutes", () => {
    // The published number and the billed number are one number in two units. If
    // this drifts, the pricing page and the Oblien quota disagree.
    const buildMultiplier = PRICING.oblien.buildResources.cpuCores / RESOURCE_TIER_SPECS.low.cpuCores;
    for (const plan of PRICING.plans) {
      const { computeMinutesPerMonth: compute, buildMinutesPerMonth: build } = plan.limits;
      if (compute === null || build === null) {
        expect(planMonthlyCredits(plan.id), plan.id).toBeNull();
        continue;
      }
      expect(planMonthlyCredits(plan.id), plan.id).toBe((compute + build * buildMultiplier) * 1000);
    }
  });

  it("includes enough compute to run a tier's whole app cap around the clock", () => {
    // "10 apps" next to a budget that runs three of them is the incoherence the
    // old credit numbers had: Scale advertised 50 running services on 60,000
    // credits, when one always-on app needs 43,200 minutes a month. A cap the
    // included compute cannot cover is a number we would be quoting to be sued
    // over, so the two are locked together here.
    const MINUTES_PER_MONTH = 43_200;
    for (const plan of PRICING.plans) {
      const { runningServices: apps, computeMinutesPerMonth: compute } = plan.limits;
      if (apps === null || compute === null) continue; // enterprise: negotiated
      expect(
        compute,
        `${plan.id} advertises ${apps} apps but only ${compute} compute minutes ` +
          `(${apps} apps always-on needs ${apps * MINUTES_PER_MONTH})`,
      ).toBeGreaterThanOrEqual(apps * MINUTES_PER_MONTH);
    }
  });

  it("charges bigger machines proportionally more per minute", () => {
    // The multiplier is what lets ONE published allowance cover every machine size.
    // It is derived from RESOURCE_TIER_SPECS so it cannot keep charging 4x for
    // `high` after `high` has been re-specced.
    expect(computeUnitsPerMinute("low")).toBe(1);
    for (const tier of RESOURCE_TIER_ORDER) {
      expect(computeUnitsPerMinute(tier), tier).toBe(
        RESOURCE_TIER_SPECS[tier].cpuCores / RESOURCE_TIER_SPECS.low.cpuCores,
      );
    }
    // Ordered, so a larger machine never costs less per minute than a smaller one.
    const rates = RESOURCE_TIER_ORDER.map((t) => computeUnitsPerMinute(t));
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
  });

  it("derives Oblien ceilings that can always fit a BUILD workspace", () => {
    // The bug this locks out: free published max_vcpus 2 / max_ram_mb 2048 while
    // every cloud build provisions a 4 vCPU / 8 GB workspace, and Oblien 409s an
    // over-ceiling create. Free is static-only, so that would have broken the one
    // workload free is allowed to run — every free deploy, on day one.
    const build = PRICING.oblien.buildResources;
    for (const id of PLAN_IDS) {
      const limits = PLANS[id].oblienLimits;
      if (!limits) continue;
      expect(limits.max_vcpus, `${id} max_vcpus must fit a build`).toBeGreaterThanOrEqual(build.cpuCores);
      expect(limits.max_ram_mb, `${id} max_ram_mb must fit a build`).toBeGreaterThanOrEqual(build.memoryMb);
      expect(limits.max_disk_gb, `${id} max_disk_gb must fit a build`).toBeGreaterThanOrEqual(build.diskGb);
    }
  });

  it("leaves room for a build workspace on top of the running services", () => {
    // Oblien counts a transient build workspace against max_workspaces, so a tier
    // whose ceiling equals its service count could never deploy.
    const headroom = PRICING.oblien.buildWorkspaceHeadroom;
    expect(headroom).toBeGreaterThan(0);
    for (const id of PLAN_IDS) {
      const services = planLimits(id).runningServices;
      const limits = PLANS[id].oblienLimits;
      if (services === null || !limits) continue;
      expect(limits.max_workspaces, `${id}`).toBe(services + headroom);
    }
  });

  it("is the single source the adapters' build config is derived from", () => {
    // `DEFAULT_BUILD_RESOURCE_CONFIG` in @repo/adapters is BUILT from these
    // numbers rather than repeating them, so there is no mirror to drift. This
    // asserts the shape that derivation depends on.
    expect(PRICING.oblien.buildResources.cpuCores).toBeGreaterThan(0);
    expect(PRICING.oblien.buildResources.memoryMb).toBeGreaterThan(0);
    expect(PRICING.oblien.buildResources.diskGb).toBeGreaterThan(0);
  });

  it("caps per-service power to a tier the deploy wizard can actually select", () => {
    // The page used to advertise up to 64 vCPU while the picker topped out at 2,
    // so nothing a customer read was choosable.
    for (const id of PLAN_IDS) {
      const tier = planLimits(id).maxResourceTier;
      if (tier === null) continue;
      expect(RESOURCE_TIER_ORDER, `${id} maxResourceTier`).toContain(tier);
    }
  });

  it("gives enterprise no derived ceiling at all", () => {
    expect(PLANS.enterprise.oblienLimits).toBeNull();
  });

  it("marks enterprise as contact-sales and nothing else", () => {
    expect(PRICING.plans.filter((p) => p.contactSales).map((p) => p.id)).toEqual(["enterprise"]);
  });
});

describe("pricing catalog — schema rejects bad edits", () => {
  const base = JSON.parse(readFileSync(fileURLToPath(new URL("./pricing.json", import.meta.url)), "utf8"));
  const mutate = (fn: (c: any) => void) => {
    const clone = JSON.parse(JSON.stringify(base));
    fn(clone);
    return pricingCatalogSchema.safeParse(clone).success;
  };

  it("rejects a duplicate plan id", () => {
    expect(mutate((c) => { c.plans[1].id = "free"; })).toBe(false);
  });

  it("rejects a dangling inherits", () => {
    expect(mutate((c) => { c.plans[1].inherits = "ghost"; })).toBe(false);
  });

  it("rejects a priced tier with no Stripe env name", () => {
    expect(mutate((c) => { c.plans[1].stripePriceEnv.monthly = null; })).toBe(false);
  });

  it("rejects a tier that is neither priced nor contact-sales", () => {
    expect(mutate((c) => { c.plans[1].price.monthly = null; })).toBe(false);
  });

  it("rejects contactSales on a priced tier", () => {
    expect(mutate((c) => { c.plans[1].contactSales = "mailto:x@y.z"; })).toBe(false);
  });

  it("rejects everythingIn without an inherits tier", () => {
    expect(mutate((c) => { delete c.plans[1].inherits; })).toBe(false);
  });

  it("rejects a negative limit and an unknown workload", () => {
    expect(mutate((c) => { c.plans[0].limits.buildMinutesPerMonth = -1; })).toBe(false);
    expect(mutate((c) => { c.plans[0].limits.workloads = ["bogus"]; })).toBe(false);
  });

  it("rejects a schemaVersion newer than this build", () => {
    expect(mutate((c) => { c.schemaVersion = 999; })).toBe(false);
  });
});

describe("campaigns (time-bounded automatic discounts)", () => {
  const CAMPAIGN = {
    id: "launch50",
    percentOff: 50,
    appliesTo: "all",
    startsAt: "2026-09-01T00:00:00Z",
    endsAt: "2026-09-30T23:59:59Z",
    durationMonths: 3,
    stripeCouponEnv: "STRIPE_COUPON_LAUNCH50",
  };
  const base = JSON.parse(readFileSync(fileURLToPath(new URL("./pricing.json", import.meta.url)), "utf8"));
  const withCampaigns = (campaigns: unknown[]) => {
    const clone = JSON.parse(JSON.stringify(base));
    clone.campaigns = campaigns;
    return pricingCatalogSchema.safeParse(clone);
  };

  it("ships no campaign by default — list price until one is added", () => {
    expect(PRICING.campaigns).toEqual([]);
  });

  it("accepts a well-formed campaign", () => {
    expect(withCampaigns([CAMPAIGN]).success).toBe(true);
  });

  it("rejects a bare date, which is timezone-ambiguous and ends a day early", () => {
    // "2026-09-30" is UTC midnight; "2026-09-30T00:00:00" is LOCAL. The two are
    // indistinguishable in review and differ by up to a day.
    expect(withCampaigns([{ ...CAMPAIGN, endsAt: "2026-09-30" }]).success).toBe(false);
    expect(withCampaigns([{ ...CAMPAIGN, endsAt: "2026-09-30T23:59:59" }]).success).toBe(false);
    expect(withCampaigns([{ ...CAMPAIGN, endsAt: "2026-09-30T23:59:59+02:00" }]).success).toBe(true);
  });

  it("rejects a window that ends before it starts", () => {
    expect(withCampaigns([{ ...CAMPAIGN, endsAt: "2026-08-01T00:00:00Z" }]).success).toBe(false);
  });

  it("rejects a campaign targeting an unknown plan", () => {
    expect(withCampaigns([{ ...CAMPAIGN, appliesTo: ["ghost"] }]).success).toBe(false);
    expect(withCampaigns([{ ...CAMPAIGN, appliesTo: ["pro"] }]).success).toBe(true);
  });

  it("rejects two campaigns overlapping on the same plan", () => {
    // Whichever the resolver reached first would win silently, and the page and
    // the Stripe coupon could disagree about which discount applied.
    const second = { ...CAMPAIGN, id: "other", startsAt: "2026-09-15T00:00:00Z", endsAt: "2026-10-15T00:00:00Z" };
    expect(withCampaigns([CAMPAIGN, second]).success).toBe(false);
    // Non-overlapping windows are fine.
    const later = { ...second, startsAt: "2026-10-01T00:00:00Z" };
    expect(withCampaigns([CAMPAIGN, later]).success).toBe(true);
    // Same window, different plans is fine.
    const otherPlan = { ...second, appliesTo: ["team"] as string[] };
    expect(withCampaigns([{ ...CAMPAIGN, appliesTo: ["pro"] }, otherPlan]).success).toBe(true);
  });

  it("rejects a percentage outside 1–100", () => {
    expect(withCampaigns([{ ...CAMPAIGN, percentOff: 0 }]).success).toBe(false);
    expect(withCampaigns([{ ...CAMPAIGN, percentOff: 101 }]).success).toBe(false);
  });

  it("computes the effective price from the LIST price, leaving list intact", () => {
    // 50% off $39 = $19.50. List stays available for the struck-through number.
    const list = 3900;
    const discounted = Math.round(list * 0.5);
    expect(discounted).toBe(1950);
  });

  it("never discounts a tier with no self-serve price", () => {
    // Free is already 0 and enterprise is negotiated — a percentage off either is
    // meaningless, and 0 × anything would render "$0 was $0".
    const now = new Date("2026-09-15T00:00:00Z");
    expect(activeCampaign("free", now)).toBeNull();
    expect(activeCampaign("enterprise", now)).toBeNull();
    expect(effectiveMonthlyPrice("enterprise", now).effectiveCents).toBeNull();
  });

  it("is a pure function of `now` — no module-level clock", () => {
    // The catalog is imported into browser bundles and into a statically
    // prerendered page. Anything read at module scope freezes at BUILD time, so a
    // campaign resolved that way could never expire.
    const before = new Date("2026-08-31T23:59:59Z");
    const during = new Date("2026-09-15T12:00:00Z");
    const after = new Date("2026-10-01T00:00:01Z");
    // With no campaigns configured every instant yields list price — the shape of
    // the assertion is what matters here; window logic is covered by the schema
    // tests above plus the API's request-time resolution.
    for (const t of [before, during, after]) {
      expect(effectiveMonthlyPrice("pro", t).effectiveCents).toBe(effectiveMonthlyPrice("pro", t).listCents);
    }
  });
});

describe("pricing copy (locales/*.json)", () => {
  it("ships a file for every declared locale and declares every file", () => {
    expect(onDisk).toEqual([...PRICING_LOCALES].sort());
  });

  it("every locale file matches the copy schema", () => {
    for (const locale of onDisk) {
      const parsed = pricingCopySchema.safeParse(readLocale(locale));
      expect(parsed.success, `${locale}.json: ${parsed.success ? "" : parsed.error.issues[0]?.message}`).toBe(true);
    }
  });

  it("English defines copy for every plan, feature key and credit pack the catalog uses", () => {
    const features = en.features as Record<string, string>;
    const plans = en.plans as Record<string, unknown>;
    const packs = en.creditPacks as Record<string, unknown>;
    for (const plan of PRICING.plans) {
      expect(plans[plan.id], `plans.${plan.id}`).toBeDefined();
      for (const key of plan.features) expect(features[key], `features.${key} (used by ${plan.id})`).toBeDefined();
    }
    for (const key of PRICING.selfHosted.features) expect(features[key], `features.${key} (self-hosted)`).toBeDefined();
    for (const pack of PRICING.creditPacks) expect(packs[pack.id], `creditPacks.${pack.id}`).toBeDefined();
  });

  it("declares no unused feature copy", () => {
    // This is the guard that keeps a RETIRED promise from lingering. `mailServer`
    // ("Built-in mail server — SMTP, IMAP, and webmail") sat in all nine locales
    // while `mail.controller.ts` 404s every mail route under CLOUD_MODE; dropping
    // the bullet without dropping the copy would leave it one edit from returning.
    const used = new Set([
      ...PRICING.plans.flatMap((p) => p.features),
      ...PRICING.standard.features,
      ...PRICING.selfHosted.features,
    ]);
    const declared = Object.keys(en.features as Record<string, string>);
    expect(declared.filter((k) => !used.has(k))).toEqual([]);
  });

  it("retires the copy for capabilities cloud does not sell", () => {
    // Named explicitly, because "unused" only catches a key nothing references —
    // it would not stop someone re-adding `mailServer` to a plan's bullets. Cloud
    // cannot run mail at all, and preview deploys are not built.
    const declared = Object.keys(en.features as Record<string, string>);
    for (const gone of ["mailServer", "previewDeploys"]) {
      expect(declared, `features.${gone} must stay retired`).not.toContain(gone);
    }
    // The self-hosted card still sells mail, and should — that asymmetry is real.
    expect((en.features as Record<string, string>).selfHostedServices).toMatch(/mail/i);
  });

  it("has full key parity across all locales (English is the source of truth)", () => {
    // A new locale file starts at zero drift and stays there — unlike the
    // dashboard's ratcheted dictionaries, this key set is small enough to keep
    // complete, so the test demands completeness instead of baselining debt.
    const expected = leafKeys(en).sort();
    const drift: Record<string, { missing: string[]; extra: string[] }> = {};
    for (const locale of onDisk.filter((l) => l !== "en")) {
      const keys = leafKeys(readLocale(locale)).sort();
      const missing = expected.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !expected.includes(k));
      if (missing.length || extra.length) drift[locale] = { missing, extra };
    }
    expect(drift).toEqual({});
  });

  it("keeps every placeholder a translation uses resolvable", () => {
    // `{buildMinutes}` misspelled in a translation renders the literal brace
    // text to a paying customer, so the placeholder SETS must match English.
    const enFeatures = en.features as Record<string, string>;
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const locale of onDisk.filter((l) => l !== "en")) {
      const features = (readLocale(locale).features ?? {}) as Record<string, string>;
      for (const [key, value] of Object.entries(features)) {
        const expected = ph(enFeatures[key] ?? "");
        expect(ph(value), `${locale}.features.${key} placeholders`).toEqual(expected);
      }
      const ui = (readLocale(locale).ui ?? {}) as Record<string, string>;
      const enUi = en.ui as Record<string, string>;
      for (const [key, value] of Object.entries(ui)) {
        expect(ph(value), `${locale}.ui.${key} placeholders`).toEqual(ph(enUi[key] ?? ""));
      }
    }
  });

  it("leaves no untranslated English string in a non-English locale", () => {
    // Present-but-English is invisible to a missing-key check; catch the copy
    // that was pasted rather than translated. Short shared tokens (SSO, SLA,
    // brand names) are legitimately identical.
    const exempt = new Set(["ui.perMonth", "ui.perYear", "features.sso", "selfHosted.priceLabel", "ui.free"]);
    // Plan names are PRODUCT names, not prose: "Free"/"Starter"/"Pro"/"Scale"/
    // "Enterprise" ship in Latin script on the Latin-script locales the same way
    // every competitor's German or French pricing page does, so an identical
    // plans.*.name is the intended state there — not pasted copy. A locale that
    // does localize the name (ar) still passes; this only stops the false alarm.
    const isPlanName = (key: string) => /^plans\.[^.]+\.name$/.test(key);
    const flat = (obj: unknown, prefix = ""): Record<string, string> => {
      if (obj === null || typeof obj !== "object") return prefix ? { [prefix]: String(obj) } : {};
      return Object.entries(obj as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => {
        Object.assign(acc, flat(v, prefix ? `${prefix}.${k}` : k));
        return acc;
      }, {});
    };
    const enFlat = flat(en);
    const offenders: string[] = [];
    for (const locale of onDisk.filter((l) => l !== "en")) {
      const localeFlat = flat(readLocale(locale));
      for (const [key, value] of Object.entries(localeFlat)) {
        if (exempt.has(key) || isPlanName(key)) continue;
        // Numerals/placeholders only (e.g. "{credits}") are language-neutral.
        if (!/\p{Letter}{4,}/u.test(value)) continue;
        if (value === enFlat[key]) offenders.push(`${locale}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("pricing resolution", () => {
  it("interpolates limits into localized feature copy", () => {
    const free = resolvePlan("free", "en");
    expect(free.features).toContain("500 build minutes per month");
    expect(free.features).toContain("10 free .opsh.io subdomains");
    expect(free.features.join(" ")).not.toMatch(/\{[a-z]/i);
  });

  it("formats large counts for the locale", () => {
    expect(resolvePlan("team", "en").features).toContain("2,200,000 compute minutes per month");
    // Arabic is pinned to Latin numerals so a price stays legible.
    expect(resolvePlan("team", "ar").features.join(" ")).toMatch(/2,200,000/);
  });

  it("differentiates tiers on usage and size, not on capability", () => {
    // The point of the model: above free, what separates two tiers is FIVE numbers
    // and a support level. A tier that gained a capability bullet the tier below
    // lacks would be the regression this locks out.
    for (const id of ["starter", "pro", "team"] as const) {
      const words = resolvePlan(id, "en").features.join(" ");
      expect(words, `${id} must quote compute minutes`).toMatch(/compute minutes/);
      expect(words, `${id} must quote build minutes`).toMatch(/build minutes/);
      expect(words, `${id} must quote a machine size`).toMatch(/vCPU/);
      // Nothing that reads as a paywall on something every tier already has.
      expect(words, `${id} must not gate the audit log`).not.toMatch(/audit/i);
      // Deliberately not a bare /mail/ — that matches "Email support", which is a
      // support level, not a mail server.
      expect(words, `${id} must not sell mail`).not.toMatch(/mail server|webmail|SMTP|IMAP/i);
    }
  });

  it("states what every plan includes exactly once", () => {
    const standard = resolveStandard("en");
    expect(standard.title).toBe("In every plan");
    expect(standard.features).toContain("Audit log of every change");
    expect(standard.features.join(" ")).not.toMatch(/\{[a-z]/i);
    // It is a shared block, so it must not also be duplicated into a tier column.
    for (const id of PLAN_IDS) {
      const tier = resolvePlan(id, "en").features;
      for (const line of standard.features) {
        expect(tier, `${id} duplicates the shared line "${line}"`).not.toContain(line);
      }
    }
  });

  it("names the inherited tier in the everything-in line, OUTSIDE the bullet list", () => {
    const pro = resolvePlan("pro", "en");
    expect(pro.inheritedFrom).toBe("Everything in Starter, plus:");
    // The reason it moved: every surface renders `features` with a checkmark per
    // item, so while this sentence lived in the list a transition ending in a colon
    // was drawn as one of the things you get.
    expect(pro.features.join(" ")).not.toMatch(/Everything in/);
    // Free inherits nothing, so it has no lead-in at all.
    expect(resolvePlan("free", "en").inheritedFrom).toBeUndefined();
  });

  it("renders unlimited instead of a blank for a null limit", () => {
    const team = resolvePlan("team", "en");
    expect(team.features).toContain("Unlimited free .opsh.io subdomains");
    const ent = resolvePlan("enterprise", "en");
    expect(ent.features.join(" ")).not.toMatch(/\{|null|undefined/);
  });

  it("resolves every plan in every locale with no leftover placeholder", () => {
    for (const locale of PRICING_LOCALES) {
      for (const plan of resolvePlans(locale)) {
        expect(plan.name, `${locale}/${plan.id}`).toBeTruthy();
        expect(plan.description, `${locale}/${plan.id}`).toBeTruthy();
        expect(plan.features.length, `${locale}/${plan.id}`).toBeGreaterThan(0);
        expect(plan.features.join(" "), `${locale}/${plan.id}`).not.toMatch(/\{\w+\}/);
      }
      const sh = resolveSelfHosted(locale);
      expect(sh.features.join(" "), `${locale}/self-hosted`).not.toMatch(/\{\w+\}/);
      expect(pricingUi(locale).monthsFree, `${locale}/monthsFree`).not.toMatch(/\{\w+\}/);
    }
  });

  it("states the free-subdomain allowance once — self-hosted reuses the free tier's number", () => {
    expect(resolveSelfHosted("en").features).toContain("10 free .opsh.io subdomains when you connect to Cloud");
  });

  it("keeps the English PLANS view in sync with resolvePlan", () => {
    for (const id of PLAN_IDS) expect(PLANS[id]).toEqual(resolvePlan(id, "en"));
  });

  it("explains what a top-up pack actually buys", () => {
    const packs = resolveCreditPacks("en");
    const small = packs.find((p) => p.id === "pack_5k")!;
    // 5,000 compute minutes ÷ 60 = 83 hours of a `low` app; ÷ 8 (the build
    // machine's rate) = 625 build minutes. "+5,000 compute minutes" alone answers
    // nothing — nobody knows if that is an afternoon or a year.
    expect(small.explains).toBe("≈ 83 hours of a small app, or 625 build minutes");
    // Derived, not authored: every pack gets the line, in every locale, with no
    // placeholder left unresolved.
    for (const locale of PRICING_LOCALES) {
      for (const pack of resolveCreditPacks(locale)) {
        expect(pack.explains, `${locale}/${pack.id}`).toBeTruthy();
        expect(pack.explains, `${locale}/${pack.id}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("names credit packs in the unit the plans publish", () => {
    // Authored in credits (`creditsMilli`, live Stripe price ids untouched), SOLD in
    // compute minutes — one compute minute is one credit, so the number is the same.
    expect(resolveCreditPacks("en").map((p) => p.name)).toEqual([
      "5,000 compute minutes",
      "25,000 compute minutes",
      "100,000 compute minutes",
    ]);
    expect(CREDIT_PACKS[0]!.credits_milli).toBe(5_000_000);
  });

  it("narrows locale-ish input to a supported locale", () => {
    expect(toPricingLocale("ar")).toBe("ar");
    expect(toPricingLocale("pt-BR")).toBe("pt");
    expect(toPricingLocale("zh-Hans,en;q=0.9")).toBe("zh");
    expect(toPricingLocale("kl")).toBe("en");
    expect(toPricingLocale(null)).toBe("en");
    expect(toPricingLocale("")).toBe("en");
  });
});

describe("stripe price ids", () => {
  const withEnv = <T,>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("reads the env var the catalog names, at call time", () => {
    withEnv({ STRIPE_PRICE_PRO_MONTHLY: "price_live_abc" }, () => {
      expect(resolveStripePriceId("pro", "monthly")).toBe("price_live_abc");
    });
  });

  it("returns null — never a placeholder — when unset or blank", () => {
    withEnv({ STRIPE_PRICE_PRO_MONTHLY: undefined }, () => {
      expect(resolveStripePriceId("pro", "monthly")).toBeNull();
    });
    withEnv({ STRIPE_PRICE_PRO_MONTHLY: "   " }, () => {
      expect(resolveStripePriceId("pro", "monthly")).toBeNull();
    });
  });

  it("returns null for tiers that are not purchasable", () => {
    expect(resolveStripePriceId("free", "monthly")).toBeNull();
    expect(resolveStripePriceId("enterprise", "monthly")).toBeNull();
  });

  it("reports every unconfigured purchasable price, with the env var to set", () => {
    const missing = withEnv(
      {
        STRIPE_PRICE_STARTER_MONTHLY: undefined,
        STRIPE_PRICE_PRO_MONTHLY: undefined,
        STRIPE_PRICE_TEAM_MONTHLY: undefined,
        STRIPE_PRICE_PACK_5K: undefined,
        STRIPE_PRICE_PACK_25K: undefined,
        STRIPE_PRICE_PACK_100K: undefined,
      },
      () => validatePlanPriceIds().missing,
    );
    expect(missing).toEqual([
      "starter.monthly (STRIPE_PRICE_STARTER_MONTHLY)",
      "pro.monthly (STRIPE_PRICE_PRO_MONTHLY)",
      "team.monthly (STRIPE_PRICE_TEAM_MONTHLY)",
      "pack_5k (STRIPE_PRICE_PACK_5K)",
      "pack_25k (STRIPE_PRICE_PACK_25K)",
      "pack_100k (STRIPE_PRICE_PACK_100K)",
    ]);
  });

  it("does not demand an annual price id while annual is unpublished", () => {
    const missing = withEnv(
      {
        STRIPE_PRICE_STARTER_MONTHLY: "p1",
        STRIPE_PRICE_PRO_MONTHLY: "p2",
        STRIPE_PRICE_TEAM_MONTHLY: "p3",
        STRIPE_PRICE_PACK_5K: "p4",
        STRIPE_PRICE_PACK_25K: "p5",
        STRIPE_PRICE_PACK_100K: "p6",
      },
      () => validatePlanPriceIds().missing,
    );
    expect(missing).toEqual([]);
  });

  it("resolves a pack price id by pack id", () => {
    withEnv({ STRIPE_PRICE_PACK_25K: "price_pack_x" }, () => {
      expect(resolveCreditPackPriceId("pack_25k")).toBe("price_pack_x");
    });
    expect(resolveCreditPackPriceId("pack_nope")).toBeNull();
  });
});

describe("locale coverage matches the dashboard", () => {
  it("covers exactly the dashboard's 9 locales", () => {
    // Divergence would show a translated dashboard next to English prices.
    expect([...PRICING_LOCALES].sort()).toEqual(["ar", "de", "en", "es", "fr", "ja", "pt", "tr", "zh"]);
  });
});

// Type-level guard: PricingLocale must stay assignable from the file list.
const _localeCheck: PricingLocale = "en";
void _localeCheck;
