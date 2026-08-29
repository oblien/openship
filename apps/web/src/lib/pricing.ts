import { cache } from "react";
import {
  PRICING,
  activeCampaigns,
  effectiveMonthlyPrice,
  pricingUi,
  resolvePlans,
  resolveSelfHosted,
  resolveStandard,
  type ActiveCampaign,
  type PlanDefinition,
} from "@repo/core";

/**
 * The pricing catalog from `@repo/core`, resolved for the marketing site.
 * Every price, limit, and plan name on the site must come through here — the
 * catalog is the only place those numbers are stated.
 *
 * The marketing site has no i18n framework (no middleware, no `[locale]`
 * segment, `lang="en"` hardcoded in the root layouts), so the catalog resolves
 * in English. It is already translated, so a future locale segment only has to
 * pass a different locale to the three resolvers below.
 *
 * ─── WHAT MAY LIVE AT MODULE SCOPE, AND WHAT MAY NOT ────────────────────────
 *
 * A module body runs ONCE per server process. In a prerendered route that
 * "once" is BUILD time, and every later render — including an ISR
 * regeneration — re-reads the same frozen value. So the rule here is:
 *
 *   • Anything that is a pure function of the committed catalog (plan names,
 *     LIST prices, limits, feature bullets) is safe as a module const. The
 *     catalog is a file in the repo; it cannot change without a deploy, and a
 *     deploy is a new process.
 *
 *   • Anything that depends on the CURRENT INSTANT — every campaign price —
 *     must be a function taking `now`, called during the render. Baking a
 *     campaign into a module const gives a discount that can never start and
 *     never expire, and `export const revalidate` would not save it: a
 *     revalidation re-runs the component, which re-reads the same constant.
 *
 * The time-dependent half of this module is therefore all functions, and
 * `/pricing` opts out of static rendering (`force-dynamic`) so those functions
 * see a real clock. See the note on `renderNow`.
 */
const LOCALE = "en";

export const UI = pricingUi(LOCALE);
export const SELF_HOSTED = resolveSelfHosted(LOCALE);
/**
 * What every cloud tier includes, stated once beside the grid.
 *
 * Safe at module scope by the rule above: it is a pure function of the committed
 * catalog, with no dependence on the current instant.
 */
export const STANDARD = resolveStandard(LOCALE);

const PLANS = resolvePlans(LOCALE);

/** A tier whose monthly price is published — narrowed so no consumer has to
 *  assert past the `number | null` and risk emitting a `0` for a custom price. */
export type PricedPlan = PlanDefinition & { price: { monthly: number; annual: number | null } };

/** Tiers with a published monthly price — the self-serve cards. */
export const TIERS: PricedPlan[] = PLANS.filter((p): p is PricedPlan => p.price.monthly !== null);
/** Tiers priced per contract — rendered as a full-width strip, not a card. */
export const CUSTOM_TIERS: PlanDefinition[] = PLANS.filter((p) => p.price.monthly === null);

const PAID = TIERS.filter((p) => p.price.monthly > 0);
const CURRENCY = PRICING.currency.toUpperCase();

/**
 * Catalog cents → display price. Whole dollars render without a cent tail
 * ("$10"), and a price WITH cents renders both of them ("$19.50").
 *
 * Both bounds move together on purpose. Leaving the minimum at 0 printed
 * "$19.5" — invisible while every catalog price was a whole dollar, and
 * unavoidable the moment a percentage campaign produced an odd half-cent price.
 */
export function money(cents: number): string {
  const digits = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: CURRENCY,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cents / 100);
}

/** JSON-LD wants a decimal string in major units; the catalog stores cents. */
export function priceLd(cents: number): string {
  return (cents / 100).toFixed(2);
}

export const CURRENCY_LD = CURRENCY;

/** The tier that costs nothing, if the catalog publishes one. */
export const FREE_TIER: PricedPlan | undefined = TIERS.find((p) => p.price.monthly === 0);

/** `ctaChoose` arrives as a template: the catalog interpolates plan numbers,
 *  not the plan's own name. */
export function chooseLabel(name: string): string {
  return UI.ctaChoose.replace(/\{name\}/g, name);
}

/* ─── Now ─────────────────────────────────────────────────────────────────── */

/**
 * The instant this render is happening.
 *
 * `cache` scopes the value to ONE render pass, so a route's layout and its page
 * — which render in the same pass but are separate modules — resolve prices
 * against the identical clock. That matters concretely: the layout emits JSON-LD
 * Offers and the page paints the price a human reads, and two bare `new Date()`
 * calls milliseconds apart could straddle a campaign's `endsAt` and publish
 * structured data that contradicts the visible page.
 *
 * This is deliberately NOT a module const. A const would be process-start time,
 * which on a prerendered route is build time. And note the converse: calling
 * this in a render does not by itself make the route dynamic — `new Date()` is
 * not one of Next's dynamic APIs — which is why `/pricing` also declares
 * `export const dynamic = "force-dynamic"`.
 */
export const renderNow = cache(() => new Date());

/* ─── Campaigns ───────────────────────────────────────────────────────────── */

/**
 * Campaign chrome.
 *
 * These three strings exist in the catalog (`locales/en.json#ui.campaignBadge`,
 * `ui.campaignEnds`, `ui.wasPrice`) but `pricingUi()` does not return them yet,
 * and the catalog is not this app's to edit — so they are mirrored here
 * verbatim, same keys, same placeholders. Delete this block and read them from
 * `UI` the moment core exposes them; nothing else here has to change.
 *
 * The catalog stays the single source of the NUMBERS — `percentOff`, the money,
 * the end date all arrive from `effectiveMonthlyPrice`/`activeCampaign`. Only
 * the sentence they sit in is duplicated.
 */
const CAMPAIGN_COPY = {
  campaignBadge: "{percentOff}% off",
  campaignEnds: "Offer ends {date}",
  wasPrice: "was {price}",
} as const;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match,
  );
}

/**
 * Fill a one-placeholder template but keep the substituted value addressable, so
 * markup can strike through JUST the old price instead of the whole "was $39"
 * phrase. Splitting here rather than hardcoding the word "was" keeps the
 * sentence in the copy file, where a translation can reorder it.
 */
function fillParts(template: string, key: string, value: string): { before: string; value: string; after: string } {
  const token = `{${key}}`;
  const at = template.indexOf(token);
  if (at < 0) return { before: template, value: "", after: "" };
  return { before: template.slice(0, at), value, after: template.slice(at + token.length) };
}

/**
 * A campaign's end date, formatted. Pinned to UTC: `endsAt` is an instant with
 * an offset, and rendering it in the server's local zone would print a different
 * day depending on which region served the request.
 */
function endsOn(campaign: ActiveCampaign): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(campaign.endsAt),
  );
}

function percent(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

export interface LiveCampaign {
  id: string;
  /** "50% off". */
  badge: string;
  /** "Offer ends September 30, 2026" — a standalone line. */
  ends: string;
  /** Just the formatted date, for prose that has to embed it mid-sentence.
   *  Lowercasing `ends` to fit a sentence would mangle the month name. */
  endsDate: string;
}

/** Every campaign live at `now`, deduplicated — for the page's offer banner. */
export function liveCampaigns(now: Date): LiveCampaign[] {
  return activeCampaigns(now).map((c) => {
    const date = endsOn(c);
    return {
      id: c.id,
      badge: fill(CAMPAIGN_COPY.campaignBadge, { percentOff: percent(c.percentOff) }),
      ends: fill(CAMPAIGN_COPY.campaignEnds, { date }),
      endsDate: date,
    };
  });
}

/** What a tier costs at `now`, list and effective, plus the campaign behind it. */
export interface PlanPricing {
  /** The catalog price in cents; null for a per-contract tier. */
  listCents: number | null;
  /** What a customer actually pays right now, in cents. */
  effectiveCents: number | null;
  campaign: ActiveCampaign | null;
  /** A campaign is live AND it genuinely lowers this tier's price. */
  discounted: boolean;
}

export function planPricing(plan: PlanDefinition, now: Date): PlanPricing {
  const { listCents, effectiveCents, campaign } = effectiveMonthlyPrice(plan.id, now);
  return {
    listCents,
    effectiveCents,
    campaign,
    discounted:
      campaign !== null && listCents !== null && effectiveCents !== null && effectiveCents < listCents,
  };
}

/* ─── Display ─────────────────────────────────────────────────────────────── */

/** What a price block shows. Everything is pre-formatted; the page renders it
 *  verbatim and decides nothing about money. */
export interface PriceBlock {
  /** The headline amount — already discounted while a campaign is live. */
  amount: string;
  /** The `/mo` suffix, when the price recurs. */
  per: string | null;
  /** The struck-through list price, split so only the money carries the strike. */
  was: { before: string; value: string; after: string } | null;
  /** "50% off". */
  badge: string | null;
  /** "Offer ends 30 September 2026". */
  ends: string | null;
}

export function priceParts(plan: PlanDefinition, now: Date): PriceBlock {
  const { listCents, effectiveCents, campaign, discounted } = planPricing(plan, now);
  const plain = { was: null, badge: null, ends: null };

  if (effectiveCents === null) return { amount: UI.custom, per: null, ...plain };
  if (effectiveCents === 0) return { amount: UI.free, per: null, ...plain };

  if (!discounted || campaign === null || listCents === null) {
    return { amount: money(effectiveCents), per: UI.perMonth, ...plain };
  }

  return {
    amount: money(effectiveCents),
    per: UI.perMonth,
    was: fillParts(CAMPAIGN_COPY.wasPrice, "price", money(listCents)),
    badge: fill(CAMPAIGN_COPY.campaignBadge, { percentOff: percent(campaign.percentOff) }),
    ends: fill(CAMPAIGN_COPY.campaignEnds, { date: endsOn(campaign) }),
  };
}

/* ─── "Cloud from …" ──────────────────────────────────────────────────────── */

/**
 * The cheapest paid tier's LIST price. Time-independent, so it is safe on a
 * statically prerendered page — it can go stale only when the catalog changes,
 * and that is a deploy. Surfaces that may be prerendered (the home page's
 * deployment models, this route's `metadata`) use this: quoting the regular
 * price during a campaign under-promises, whereas a frozen discount would
 * outlive the offer and advertise a price we no longer honour.
 */
export const CHEAPEST_PAID_LIST_CENTS: number | null =
  PAID.length > 0 ? Math.min(...PAID.map((p) => p.price.monthly)) : null;
export const CLOUD_FROM_LIST: string | null =
  CHEAPEST_PAID_LIST_CENTS === null ? null : money(CHEAPEST_PAID_LIST_CENTS);

/** The cheapest paid tier at `now`, in cents — discounted while a campaign runs.
 *  Null when nothing is purchasable. */
export function cheapestPaidCents(now: Date): number | null {
  const cents = PAID.map((p) => planPricing(p, now).effectiveCents).filter(
    (c): c is number => c !== null,
  );
  return cents.length > 0 ? Math.min(...cents) : null;
}

/** "…from $5 a month" for the hero, at `now`. */
export function cloudFrom(now: Date): string | null {
  const cents = cheapestPaidCents(now);
  return cents === null ? null : money(cents);
}

/** The paid ladder as prose at `now`: "Starter at $10/mo, Pro at $39/mo, …".
 *  Prices are what a customer would pay today, campaign included. */
export function paidLadder(now: Date): string {
  return PAID.map((p) => {
    const { effectiveCents } = planPricing(p, now);
    return `${p.name} at ${money(effectiveCents ?? p.price.monthly)}${UI.perMonth}`;
  }).join(", ");
}
