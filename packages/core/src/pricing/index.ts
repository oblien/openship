/**
 * Pricing — the resolved, localized view of `pricing.json`.
 *
 * ONE editable file (`pricing.json`) owns every number we charge or allow; one
 * file per language (`locales/<lang>.json`) owns every word. Nothing about a
 * price, an allowance, or a plan's copy lives in TypeScript, so publishing a
 * price change is a JSON edit plus a test run — no code reading required.
 *
 * Three surfaces consume this and MUST agree, which is why the copy travels with
 * the catalog instead of living in one app's dictionary: the API
 * (`GET /api/billing/plans`), the dashboard's billing pages, and the marketing
 * site's `/pricing` (which has no i18n framework of its own). UI CHROME — button
 * labels, tab names — stays in each app's own dictionary; only plan-specific copy
 * is here.
 *
 * Enforcement reads `planLimits()`, never the localized view: limits are numbers
 * and must not depend on which language a request arrived in.
 */

import { pricingCatalogSchema, type PricingCatalogRaw, type PricingCreditPackRaw } from "./schema";
import type { WorkloadType } from "../deployment-class";
import { RESOURCE_TIER_SPECS, type FixedResourceTier } from "../resources";

import rawCatalog from "./pricing.json";
import copyEn from "./locales/en.json";
import copyAr from "./locales/ar.json";
import copyDe from "./locales/de.json";
import copyEs from "./locales/es.json";
import copyFr from "./locales/fr.json";
import copyJa from "./locales/ja.json";
import copyPt from "./locales/pt.json";
import copyTr from "./locales/tr.json";
import copyZh from "./locales/zh.json";

/* ─── Catalog ─────────────────────────────────────────────────────────────── */

/**
 * Parsed at module load and THROWS on a malformed edit. The catalog is a
 * committed file, so a bad edit is a build-breaking bug that must surface in CI
 * (and locally) rather than degrade a price to `undefined` inside a checkout.
 */
export const PRICING: PricingCatalogRaw = pricingCatalogSchema.parse(rawCatalog);

/** Plan tier identifier. Mirrors `pricing.json#plans[].id`; the pricing test
 *  asserts the two never drift (a new tier is a compile error, by design). */
export type PlanTierId = "free" | "starter" | "pro" | "team" | "enterprise";

/** Ordered plan ids, display order = catalog order. */
export const PLAN_IDS: readonly PlanTierId[] = PRICING.plans.map((p) => p.id as PlanTierId);

/** The lowest tier — what an org without a subscription is on. */
export const DEFAULT_PLAN_TIER: PlanTierId = "free";

/* ─── Locales ─────────────────────────────────────────────────────────────── */

export const PRICING_LOCALES = ["en", "ar", "de", "es", "fr", "ja", "pt", "tr", "zh"] as const;
export type PricingLocale = (typeof PRICING_LOCALES)[number];

/** English copy — the source of truth and the fallback for every other locale. */
type PricingCopy = typeof copyEn;
/** A translation may omit any key; the omission falls back to English. */
type PartialCopy = {
  plans?: Record<string, { name?: string; tagline?: string }>;
  features?: Record<string, string>;
  selfHosted?: Partial<PricingCopy["selfHosted"]>;
  creditPacks?: Record<string, string>;
  ui?: Partial<PricingCopy["ui"]>;
};

const COPY: Record<PricingLocale, PartialCopy> = {
  en: copyEn,
  ar: copyAr,
  de: copyDe,
  es: copyEs,
  fr: copyFr,
  ja: copyJa,
  pt: copyPt,
  tr: copyTr,
  zh: copyZh,
};

/**
 * Narrow any locale-ish string to a supported pricing locale: an exact match,
 * else its base language (`pt-BR` → `pt`), else English. Accepts a raw
 * `Accept-Language` header value — the first tag wins.
 */
export function toPricingLocale(value: string | null | undefined): PricingLocale {
  if (!value) return "en";
  const first = value.split(",")[0]?.trim().toLowerCase() ?? "";
  const exact = PRICING_LOCALES.find((l) => l === first);
  if (exact) return exact;
  const base = first.split("-")[0];
  return PRICING_LOCALES.find((l) => l === base) ?? "en";
}

/**
 * Arabic renders Arabic-Indic digits by default (`٦٠٬٠٠٠`). Every other number
 * in the product is Latin (the dashboard localizes words, not numerals), so
 * pin the numbering system to keep a price legible next to its own currency.
 */
const NUMBER_LOCALE: Partial<Record<PricingLocale, string>> = { ar: "ar-u-nu-latn" };

function formatCount(value: number, locale: PricingLocale): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? locale).format(value);
}

/** Machine sizes are fractional (0.25 vCPU, 0.5 GB) — keep one decimal when it
 *  carries meaning and drop it when it doesn't, so "0.5 vCPU" and "2 vCPU" both
 *  read naturally. */
function formatDecimal(value: number, locale: PricingLocale): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? locale, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

/** `{key}` → value. Unknown placeholders are left verbatim so a translation
 *  typo shows up as `{buildMinutes}` in review instead of silently blanking. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match,
  );
}

function copyFor(locale: PricingLocale): PartialCopy {
  return COPY[locale] ?? COPY.en;
}

function uiString(locale: PricingLocale, key: keyof PricingCopy["ui"]): string {
  return copyFor(locale).ui?.[key] ?? copyEn.ui[key];
}

function planName(planId: string, locale: PricingLocale): string {
  return copyFor(locale).plans?.[planId]?.name ?? copyEn.plans[planId as PlanTierId]?.name ?? planId;
}

function planTagline(planId: string, locale: PricingLocale): string {
  return copyFor(locale).plans?.[planId]?.tagline ?? copyEn.plans[planId as PlanTierId]?.tagline ?? "";
}

function featureTemplate(key: string, locale: PricingLocale): string | null {
  return copyFor(locale).features?.[key] ?? (copyEn.features as Record<string, string>)[key] ?? null;
}

/* ─── Public types ────────────────────────────────────────────────────────── */

/**
 * Oblien per-workspace ceilings pushed at provision time. `null` means the tier
 * is custom (enterprise) and limits are negotiated per contract.
 */
export interface OblienLimits {
  max_workspaces: number;
  max_vcpus: number;
  max_ram_mb: number;
  max_disk_gb: number;
}

/** Numeric plan limits, in customer-facing units. `null` is ALWAYS "unlimited". */
export interface PlanLimits {
  workloads: readonly WorkloadType[];
  services: boolean;
  /** Concurrently running services — one Oblien workspace each. */
  runningServices: number | null;
  maxProjects: number | null;
  /** Largest per-service machine this tier may select, or null for uncapped. */
  maxResourceTier: FixedResourceTier | null;
  /** App runtime included per month, in `low`-machine minutes. See the schema. */
  computeMinutesPerMonth: number | null;
  buildMinutesPerMonth: number | null;
  freeSubdomains: number | null;
  customDomains: number | null;
  seats: number | null;
}

/**
 * A plan resolved for one language. `features` are finished strings (numbers
 * already interpolated and locale-formatted) — the UI renders them verbatim.
 */
export interface PlanDefinition {
  id: PlanTierId;
  name: string;
  /**
   * The resolved "Everything in X, plus:" line, or undefined on a tier that
   * inherits nothing.
   *
   * Kept OUT of `features` deliberately. It is a transition, not a feature, and
   * while it sat in the list every surface rendered it with a checkmark beside it —
   * so a sentence ending in a colon read as one of the things you get. Callers
   * render it as a lead-in above the ticked list.
   */
  inheritedFrom?: string;
  /** The tier's one-line pitch. (Named `description` for the pre-catalog API
   *  payload shape, which clients already read.) */
  description: string;
  price: { monthly: number | null; annual: number | null };
  /** Milli-credits granted per period; null = granted by hand (enterprise). */
  monthlyCredits: number | null;
  oblienLimits: OblienLimits | null;
  limits: PlanLimits;
  features: readonly string[];
  popular: boolean;
  support: string;
  contactSales?: string;
}

export interface CreditPackDefinition {
  id: string;
  name: string;
  credits_milli: number;
  price_cents: number;
  sortOrder: number;
  /**
   * One line saying what the pack BUYS, in things the customer recognises —
   * hours of a running app, or build minutes.
   *
   * "+25,000 compute minutes" is a true statement that answers nothing: nobody
   * knows whether that is an afternoon or a year. Both figures are derived from
   * the catalog's own rates (`computeUnitsPerMinute`, `oblien.buildResources`), so
   * they cannot drift from what the pack actually gets spent on.
   */
  explains: string;
}

/* ─── Resolution ──────────────────────────────────────────────────────────── */

const PLAN_BY_ID = new Map(PRICING.plans.map((p) => [p.id, p]));

/**
 * The raw limits for a tier — locale-free, the ONLY thing enforcement should
 * read. An unknown tier string (a stale `plan_tier_id` in the DB, a hand-edited
 * row) falls back to the free tier's limits: the safe direction is the most
 * restrictive one, and it can never be `undefined` at a gate.
 */
export function planLimits(planId: string | null | undefined): PlanLimits {
  const plan = PLAN_BY_ID.get(planId ?? "") ?? PLAN_BY_ID.get(DEFAULT_PLAN_TIER)!;
  return plan.limits;
}

/**
 * Milli-credits burned by one compute minute — one minute of a `low` machine.
 *
 * Lives here, not beside `MILLI_PER_CREDIT` in the API's `billing-credit-units.ts`:
 * that file is deliberately import-free and owns a different boundary (openship
 * milli ↔ Oblien whole credits). This is a CATALOG unit, and `packages/core`
 * cannot import from `apps/api` anyway. One compute minute ≡ one credit, so the
 * two constants agree by construction; the pricing test asserts it.
 */
export const MILLI_PER_COMPUTE_MINUTE = 1000;

/**
 * Compute units burned per minute by a machine size — `low` is the unit, so it is
 * 1× and everything else is its ratio.
 *
 * Derived from `RESOURCE_TIER_SPECS`, never a hand-written table, for the same
 * reason `placeholders()` quotes `powerCpu` from it: the published rate has to
 * follow the sizes the deploy wizard actually offers. A hand-written multiplier
 * would silently keep charging 4× for `high` after `high` was re-specced.
 */
export function computeUnitsPerMinute(tier: FixedResourceTier): number {
  return RESOURCE_TIER_SPECS[tier].cpuCores / RESOURCE_TIER_SPECS.low.cpuCores;
}

/** Compute units a minute of the BUILD machine burns (its own workspace, and
 *  Oblien meters it like any other). */
function buildUnitsPerMinute(): number {
  return PRICING.oblien.buildResources.cpuCores / RESOURCE_TIER_SPECS.low.cpuCores;
}

/**
 * Milli-credits a tier grants per period; null = hand-granted (enterprise).
 *
 * DERIVED from the two published allowances rather than authored, so the figure on
 * the pricing page and the quota pushed to Oblien are one number in two units.
 * (Same direction as `toOblienLimits` below, and for the same reason.)
 *
 * Build minutes are in the sum, and that is load-bearing rather than tidy:
 * `toOblienCredits()` REJECTS a non-positive quota, and a static-only tier
 * legitimately publishes 0 compute minutes — so a compute-only derivation would
 * make every free-tier quota push throw. Builds are also real metered work in a
 * real workspace, so counting them is the honest reading either way.
 */
export function planMonthlyCredits(planId: string | null | undefined): number | null {
  const plan = PLAN_BY_ID.get(planId ?? "") ?? PLAN_BY_ID.get(DEFAULT_PLAN_TIER)!;
  const { computeMinutesPerMonth, buildMinutesPerMonth } = plan.limits;
  // Either allowance being unlimited makes the whole grant hand-managed — there is
  // no finite number to push.
  if (computeMinutesPerMonth === null || buildMinutesPerMonth === null) return null;
  const units = computeMinutesPerMonth + buildMinutesPerMonth * buildUnitsPerMinute();
  return Math.round(units * MILLI_PER_COMPUTE_MINUTE);
}

/** May this tier run that workload? Free ships static-only. */
export function planAllowsWorkload(planId: string | null | undefined, workload: WorkloadType): boolean {
  return planLimits(planId).workloads.includes(workload);
}

/** May this tier run multi-service stacks — Compose, catalog apps, managed DBs? */
export function planAllowsServices(planId: string | null | undefined): boolean {
  return planLimits(planId).services;
}

/**
 * DERIVE Oblien's per-namespace ceilings from the customer-facing limits.
 *
 * Three of Oblien's four ceilings are PER-WORKSPACE (`max_vcpus`, `max_ram_mb`,
 * `max_disk_gb`); only `max_workspaces` is namespace-wide. So:
 *
 *   max_workspaces = running services + build headroom — a build runs in its own
 *     workspace and Oblien counts it, so without headroom a tier's last service
 *     slot would block every deploy.
 *   max_vcpus / max_ram_mb / max_disk_gb = the MAX of what a service may select
 *     and what a BUILD needs. A ceiling below the build machine means Oblien 409s
 *     every build — which is exactly how the free tier (2 vCPU / 2 GB against a
 *     4 vCPU / 8 GB build) would have lost the only workload it's allowed to run.
 *
 * Returns null only for a genuinely uncapped tier (enterprise). Previously this
 * returned null when ANY single dimension was null, so loosening one knob
 * silently un-enforced all four.
 *
 * CONSEQUENCE WORTH UNDERSTANDING: because the build machine dominates the max,
 * `max_vcpus`/`max_ram_mb` come out IDENTICAL on every tier. Oblien applies one
 * per-workspace ceiling to the whole namespace and cannot tell a build workspace
 * from a runtime one, so it physically cannot both fit a build and cap a
 * service. Oblien is therefore the coarse BACKSTOP; the per-service size cap
 * (`maxResourceTier`) is enforced Openship-side by `assertPlanAllowsResourceTier`
 * where the machine is actually chosen. Do not read equal ceilings as a bug.
 */
function toOblienLimits(limits: PlanLimits): OblienLimits | null {
  const { runningServices, maxResourceTier } = limits;
  if (runningServices === null && maxResourceTier === null) return null;

  const build = PRICING.oblien.buildResources;
  const svc = maxResourceTier ? RESOURCE_TIER_SPECS[maxResourceTier] : null;

  return {
    max_workspaces:
      runningServices === null
        ? UNCAPPED_WORKSPACES
        : runningServices + PRICING.oblien.buildWorkspaceHeadroom,
    max_vcpus: Math.ceil(Math.max(svc?.cpuCores ?? 0, build.cpuCores)),
    max_ram_mb: Math.max(svc?.memoryMb ?? 0, build.memoryMb),
    max_disk_gb: Math.max(svc ? Math.ceil(svc.diskMb / 1024) : 0, build.diskGb),
  };
}

/**
 * What `max_workspaces` becomes for a tier with unlimited services but a capped
 * machine size. Oblien takes a number, not "unlimited", so a high sentinel is the
 * only way to express "don't cap the count but do cap the size" — and leaving the
 * whole ceiling null instead would drop the size cap too.
 */
const UNCAPPED_WORKSPACES = 10_000;

/**
 * Placeholder values a feature string may interpolate for a given plan.
 *
 * Every per-service machine figure comes from `RESOURCE_TIER_SPECS` — the same
 * table the deploy wizard's picker renders — so the size quoted on the pricing
 * page is a size the customer can actually choose. Publishing raw numbers here
 * is what left the page advertising 64 vCPU while the picker topped out at 2.
 */
function placeholders(plan: PricingCatalogRaw["plans"][number], locale: PricingLocale): Record<string, string> {
  const unlimited = uiString(locale, "unlimited");
  const n = (v: number | null) => (v === null ? unlimited : formatCount(v, locale));
  const { limits } = plan;
  const svc = limits.maxResourceTier ? RESOURCE_TIER_SPECS[limits.maxResourceTier] : null;
  return {
    buildMinutes: n(limits.buildMinutesPerMonth),
    freeSubdomains: n(limits.freeSubdomains),
    customDomains: n(limits.customDomains),
    seats: n(limits.seats),
    runningServices: n(limits.runningServices),
    maxProjects: n(limits.maxProjects),
    // Per-SERVICE machine size, not a pool — the copy must say so.
    powerCpu: svc ? formatDecimal(svc.cpuCores, locale) : unlimited,
    powerRamGb: svc ? formatDecimal(svc.memoryMb / 1024, locale) : unlimited,
    powerDiskGb: svc ? formatCount(Math.round(svc.diskMb / 1024), locale) : unlimited,
    computeMinutes: n(limits.computeMinutesPerMonth),
    inherited: plan.inherits ? planName(plan.inherits, locale) : "",
    freeDomainSuffix: PRICING.freeDomainSuffix,
  };
}

/** The one feature key that resolves to a lead-in rather than a bullet. The
 *  schema already refuses it on a tier with no `inherits`. */
const EVERYTHING_IN_KEY = "everythingIn";

/** Resolve one tier's card for a language. */
export function resolvePlan(planId: PlanTierId, locale: PricingLocale = "en"): PlanDefinition {
  const plan = PLAN_BY_ID.get(planId) ?? PLAN_BY_ID.get(DEFAULT_PLAN_TIER)!;
  const values = placeholders(plan, locale);
  return {
    id: plan.id as PlanTierId,
    name: planName(plan.id, locale),
    description: planTagline(plan.id, locale),
    price: plan.price,
    monthlyCredits: planMonthlyCredits(plan.id),
    oblienLimits: toOblienLimits(plan.limits),
    limits: plan.limits,
    ...(() => {
      // `everythingIn` is authored inside `features` so the catalog keeps ONE
      // ordered list per tier, but it resolves to its own field — see
      // `inheritedFrom`. Anything else stays a bullet.
      const lead = plan.features.includes(EVERYTHING_IN_KEY)
        ? featureTemplate(EVERYTHING_IN_KEY, locale)
        : null;
      return lead === null ? {} : { inheritedFrom: fill(lead, values) };
    })(),
    features: plan.features
      .filter((key) => key !== EVERYTHING_IN_KEY)
      .map((key) => {
        const template = featureTemplate(key, locale);
        return template === null ? null : fill(template, values);
      })
      .filter((s): s is string => s !== null),
    popular: plan.popular,
    support: plan.support,
    ...(plan.contactSales ? { contactSales: plan.contactSales } : {}),
  };
}

/** Every tier, in display order, resolved for a language. */
export function resolvePlans(locale: PricingLocale = "en"): PlanDefinition[] {
  return PLAN_IDS.map((id) => resolvePlan(id, locale));
}

/* ─── Campaigns (time-bounded automatic discounts) ────────────────────────── */

export interface ActiveCampaign {
  id: string;
  percentOff: number;
  /** Months the discount lasts per customer; null = subscription lifetime. */
  durationMonths: number | null;
  /** ISO instant the offer closes — for a countdown or a "ends <date>" line. */
  endsAt: string;
  /** Env var naming the Stripe coupon. Resolve server-side only. */
  stripeCouponEnv: string;
}

/**
 * The campaign in effect for a plan at a given instant, or null.
 *
 * `now` is a REQUIRED argument and is never read from the module. Two concrete
 * reasons, both of which would ship a wrong price:
 *
 *   1. This module is imported into browser bundles and into the statically
 *      prerendered marketing site. Anything evaluated at module scope is frozen
 *      at BUILD time — a campaign baked in that way could never expire, and
 *      `export const revalidate` would not help, because re-running a component
 *      re-reads the same frozen constant.
 *   2. A pure function of `now` is testable at a boundary, which is where
 *      discount bugs live.
 *
 * Callers on a request path pass `new Date()`; prerendered pages must render
 * dynamically (or revalidate) for an expiry to ever take effect.
 */
export function activeCampaign(planId: PlanTierId, now: Date): ActiveCampaign | null {
  const plan = PLAN_BY_ID.get(planId);
  // Nothing to discount on a tier with no self-serve price.
  if (!plan || plan.price.monthly === null || plan.price.monthly === 0) return null;

  const t = now.getTime();
  const match = PRICING.campaigns.find((c) => {
    if (Date.parse(c.startsAt) > t || Date.parse(c.endsAt) <= t) return false;
    return c.appliesTo === "all" || c.appliesTo.includes(planId);
  });
  if (!match) return null;

  return {
    id: match.id,
    percentOff: match.percentOff,
    durationMonths: match.durationMonths,
    endsAt: match.endsAt,
    stripeCouponEnv: match.stripeCouponEnv,
  };
}

/** Any campaign live at `now`, for a site-wide banner. */
export function activeCampaigns(now: Date): ActiveCampaign[] {
  const seen = new Set<string>();
  const out: ActiveCampaign[] = [];
  for (const id of PLAN_IDS) {
    const c = activeCampaign(id, now);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

export interface EffectivePrice {
  /** The catalog price in cents — what gets struck through when discounted. */
  listCents: number | null;
  /** What the customer actually pays now, in cents. Equals `listCents` when
   *  there's no campaign. */
  effectiveCents: number | null;
  campaign: ActiveCampaign | null;
}

/**
 * What a tier costs at `now`, list and effective.
 *
 * Rounds to whole cents the way Stripe does for a percentage coupon (its own
 * rounding is half-up on the minor unit), so the number shown matches the number
 * charged. A tier with no self-serve price passes through untouched.
 */
export function effectiveMonthlyPrice(planId: PlanTierId, now: Date): EffectivePrice {
  const listCents = PLAN_BY_ID.get(planId)?.price.monthly ?? null;
  const campaign = activeCampaign(planId, now);
  if (listCents === null || campaign === null) {
    return { listCents, effectiveCents: listCents, campaign: null };
  }
  const effectiveCents = Math.round(listCents * (1 - campaign.percentOff / 100));
  return { listCents, effectiveCents, campaign };
}

/**
 * Resolve the Stripe coupon id for a live campaign, from the env var the catalog
 * names. Server only, read at call time — same indirection as price ids, so no
 * live coupon id is committed or shipped to a browser.
 *
 * Null means "configured badly": the campaign is live in the catalog but its
 * coupon isn't set. Callers must fall back to charging LIST price rather than
 * guessing, because the alternative is advertising a discount Stripe won't apply.
 */
export function resolveCampaignCouponId(campaign: ActiveCampaign): string | null {
  const value = process.env[campaign.stripeCouponEnv];
  return value && value.trim().length > 0 ? value.trim() : null;
}

/**
 * English-resolved tiers, keyed by id — the back-compatible view server code
 * reads for limits and quota pushes. User-facing surfaces should call
 * `resolvePlans(locale)` so copy arrives in the reader's language.
 */
export const PLANS: Record<PlanTierId, PlanDefinition> = Object.fromEntries(
  PLAN_IDS.map((id) => [id, resolvePlan(id, "en")]),
) as Record<PlanTierId, PlanDefinition>;

/**
 * What every cloud tier includes, resolved once for a language.
 *
 * Rendered as a single block beside the tier grid instead of repeated into each
 * column. Placeholders resolve against the FREE plan — the same choice
 * `resolveSelfHosted` makes — because a line in here is true on every tier, so the
 * lowest one is the honest source for any number it quotes.
 */
export function resolveStandard(locale: PricingLocale = "en"): {
  title: string;
  features: string[];
} {
  const free = PLAN_BY_ID.get(DEFAULT_PLAN_TIER)!;
  const values = placeholders(free, locale);
  return {
    title: uiString(locale, "standardTitle"),
    features: PRICING.standard.features
      .map((key) => {
        const template = featureTemplate(key, locale);
        return template === null ? null : fill(template, values);
      })
      .filter((s): s is string => s !== null),
  };
}

/** The self-hosted card — free forever, not a billable tier. Its numbers come
 *  from the FREE plan, so "10 free subdomains" is stated once in the catalog. */
export function resolveSelfHosted(locale: PricingLocale = "en") {
  const free = PLAN_BY_ID.get(DEFAULT_PLAN_TIER)!;
  const values = placeholders(free, locale);
  const sh = copyFor(locale).selfHosted ?? {};
  return {
    name: sh.name ?? copyEn.selfHosted.name,
    tagline: sh.tagline ?? copyEn.selfHosted.tagline,
    priceLabel: sh.priceLabel ?? copyEn.selfHosted.priceLabel,
    priceNote: sh.priceNote ?? copyEn.selfHosted.priceNote,
    cta: sh.cta ?? copyEn.selfHosted.cta,
    features: PRICING.selfHosted.features
      .map((key) => {
        const template = featureTemplate(key, locale);
        return template === null ? null : fill(template, values);
      })
      .filter((s): s is string => s !== null),
  };
}

/** Top-up packs, resolved for a language and sorted for display. */
export function resolveCreditPacks(locale: PricingLocale = "en"): CreditPackDefinition[] {
  return [...PRICING.creditPacks]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((pack) => {
      const template = copyFor(locale).creditPacks?.[pack.id] ?? copyEn.creditPacks[pack.id as keyof PricingCopy["creditPacks"]] ?? "{computeMinutes}";
      // Both tokens carry the same number. A pack is still AUTHORED in credits —
      // `creditsMilli` and its live Stripe price id are untouched — but it is SOLD
      // as compute minutes, because that is the unit the plans publish and one
      // compute minute ≡ one credit. `{credits}` stays accepted so a translation
      // that hasn't been updated yet still renders a number instead of a literal
      // placeholder.
      const minutes = pack.creditsMilli / MILLI_PER_COMPUTE_MINUTE;
      const amount = formatCount(minutes, locale);
      // What the pack is worth in the two things people actually spend it on. The
      // app figure is the BASE (`low`) machine — the honest floor, since a bigger
      // machine burns a multiple — and the build figure divides by the build
      // machine's own rate.
      const noteTemplate =
        copyFor(locale).ui?.creditPackNote ?? copyEn.ui.creditPackNote;
      return {
        id: pack.id,
        name: fill(template, { computeMinutes: amount, credits: amount }),
        explains: fill(noteTemplate, {
          appHours: formatCount(Math.round(minutes / 60), locale),
          buildMinutes: formatCount(Math.round(minutes / buildUnitsPerMinute()), locale),
        }),
        credits_milli: pack.creditsMilli,
        price_cents: pack.priceCents,
        sortOrder: pack.sortOrder,
      };
    });
}

/** English-resolved packs — the catalog server code syncs to `credit_pack`. */
export const CREDIT_PACKS: readonly CreditPackDefinition[] = resolveCreditPacks("en");

/** Strings the marketing site and the plan cards need but can't get from an
 *  app dictionary (the marketing site has none). */
export function pricingUi(locale: PricingLocale = "en") {
  return {
    perMonth: uiString(locale, "perMonth"),
    perYear: uiString(locale, "perYear"),
    custom: uiString(locale, "custom"),
    free: uiString(locale, "free"),
    unlimited: uiString(locale, "unlimited"),
    mostPopular: uiString(locale, "mostPopular"),
    monthsFree: fill(uiString(locale, "monthsFree"), { months: formatCount(PRICING.annual.monthsFree, locale) }),
    ctaStart: uiString(locale, "ctaStart"),
    ctaChoose: uiString(locale, "ctaChoose"),
    ctaContact: uiString(locale, "ctaContact"),
    billedMonthly: uiString(locale, "billedMonthly"),
    standardTitle: uiString(locale, "standardTitle"),
    // Campaign strings are returned as TEMPLATES with their placeholders intact,
    // like `ctaChoose`: `{percentOff}`, `{date}` and `{price}` are per-plan and
    // per-render values (the discount differs by tier, the date needs the
    // reader's own date formatting), so the client fills them. Omitting them here
    // is what kept a live campaign's badge and end-date from ever reaching the
    // dashboard even though the copy existed in all nine locales.
    campaignBadge: uiString(locale, "campaignBadge"),
    campaignEnds: uiString(locale, "campaignEnds"),
    wasPrice: uiString(locale, "wasPrice"),
  };
}

/** Is annual billing published? False keeps every annual affordance hidden. */
export const ANNUAL_ENABLED = PRICING.annual.enabled;
/** Months waived on an annual term, for the "N months free" badge. */
export const ANNUAL_MONTHS_FREE = PRICING.annual.monthsFree;
/** Suffix of the managed free domain, e.g. `.opsh.io`. */
export const FREE_DOMAIN_SUFFIX = PRICING.freeDomainSuffix;

/* ─── Stripe price ids (server only) ─────────────────────────────────────── */

/**
 * Resolve a tier's Stripe price id from the env var the catalog NAMES, read at
 * call time. Returns null when the tier isn't purchasable (free, enterprise) or
 * when the operator hasn't set the env var — callers must treat null as
 * "not configured" and refuse, never as "free".
 */
export function resolveStripePriceId(
  planId: PlanTierId,
  interval: "monthly" | "annual",
): string | null {
  const envName = PLAN_BY_ID.get(planId)?.stripePriceEnv[interval];
  if (!envName) return null;
  const value = process.env[envName];
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** Same, for a top-up pack. */
export function resolveCreditPackPriceId(packId: string): string | null {
  const envName = PRICING.creditPacks.find((p) => p.id === packId)?.stripePriceEnv;
  if (!envName) return null;
  const value = process.env[envName];
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** The raw pack row (price/credits), for server code that needs the numbers. */
export function creditPack(packId: string): PricingCreditPackRaw | undefined {
  return PRICING.creditPacks.find((p) => p.id === packId);
}

export interface PlanPriceIdValidation {
  /** Labels of purchasable prices with no configured env value, e.g.
   *  "pro.monthly" / "pack_5k" — plus the env var name to set. */
  missing: string[];
}

/**
 * Boot check: every PURCHASABLE price in the catalog has a real Stripe price id
 * in the environment. CLOUD_MODE callers treat a non-empty result as fatal —
 * otherwise checkout reaches Stripe with an undefined price and fails with a
 * cryptic Stripe-side error. Self-hosted callers may log and continue (billing
 * is disabled there).
 */
export function validatePlanPriceIds(): PlanPriceIdValidation {
  const missing: string[] = [];

  for (const plan of PRICING.plans) {
    for (const interval of ["monthly", "annual"] as const) {
      const envName = plan.stripePriceEnv[interval];
      const price = plan.price[interval];
      // Only a published, non-zero price needs a Stripe id. Annual stays unset
      // while `annual.enabled` is false.
      if (!envName || price === null || price === 0) continue;
      if (!resolveStripePriceId(plan.id as PlanTierId, interval)) {
        missing.push(`${plan.id}.${interval} (${envName})`);
      }
    }
  }

  for (const pack of PRICING.creditPacks) {
    if (!resolveCreditPackPriceId(pack.id)) {
      missing.push(`${pack.id} (${pack.stripePriceEnv})`);
    }
  }

  return { missing };
}
