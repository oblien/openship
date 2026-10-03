"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React from "react";
import {
  resolveStandard,
  toPricingLocale,
  type OblienLimits,
  type PlanLimits,
  type PlanTierId,
} from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { PlanResources } from "./PlanResources";
import { PlanIcon } from "./PlanIcon";
import { PlanFeatures } from "./PlanFeatures";
import { PlanUsageNote } from "./PlanUsageNote";

/* ------------------------------------------------------------------ */
/*  Types — mirror the shape returned by GET /api/billing/plans       */
/* ------------------------------------------------------------------ */

/**
 * A live automatic discount on this plan, as the API reports it. The Stripe
 * coupon env name is deliberately absent from the payload — it is server config.
 */
export interface ApiCampaign {
  id: string;
  percentOff: number;
  /** Months the discount lasts per customer; null = subscription lifetime. */
  durationMonths: number | null;
  /** ISO instant the offer closes. */
  endsAt: string;
}

export interface ApiPlan {
  id: PlanTierId;
  configuration?: "preset" | "custom";
  offerReference?: string;
  name: string;
  description: string;
  popular: boolean;
  /**
   * The LIST price — cents OR null. Null = "contact sales" / no Stripe price.
   * Every purchasability decision on this card keys off THIS field, never off
   * the effective one: a 100%-off campaign must not turn a paid tier into the
   * free tier's card.
   */
  price: { monthly: number | null; annual: number | null };
  /** Same number as `price.monthly`, named for symmetry with `effectivePrice`. */
  listPrice: { monthly: number | null };
  /** What is actually charged right now — equals the list price when no
   *  campaign is live. Evaluated per REQUEST server-side, so it expires. */
  effectivePrice: { monthly: number | null };
  campaign: ApiCampaign | null;
  monthlyCredits: number | null;
  /** Milli-credits granted for an annual cycle, reported separately by Oblien. */
  annualCredits?: number | null;
  /** Namespace edge traffic allowance, supplied by the Cloud plan catalog. */
  edge?: { bandwidthGb: number | null };
  /**
   * The tier's ceilings in CUSTOMER-FACING units, straight off the pricing
   * catalog — typed as the catalog's own `PlanLimits` so a limit added or
   * removed there is a compile error here rather than a silently dead field.
   */
  limits: PlanLimits;
  /** Declared shared VM pool, supplied by the live catalog or saved paid offer. */
  resourceLimits?: OblienLimits;
  /** Finished localized strings, numbers already interpolated by the catalog. */
  features: string[];
  /** Optional for older APIs; aligned with features when supplied. */
  featureKeys?: readonly string[];
  /** "Everything in X, plus:" — a lead-in, NOT a bullet, so it renders above the
   *  ticked list without a checkmark of its own. */
  inheritedFrom?: string | null;
  support: string;
  contactSales?: string | null;
}

/**
 * `data.ui` — plan-card words that travel with the pricing catalog instead of
 * this app's dictionary, so the dashboard, the API and the marketing site can't
 * word the same ladder differently.
 */
export interface ApiPricingUi {
  perMonth: string;
  perYear: string;
  custom: string;
  free: string;
  unlimited: string;
  mostPopular: string;
  monthsFree: string;
  ctaStart: string;
  /** Carries a `{name}` placeholder — the only ui string the client fills. */
  ctaChoose: string;
  ctaContact: string;
  billedMonthly: string;
  /**
   * Campaign words. OPTIONAL because they are newer than the endpoint: the
   * catalog's `locales/*.json` define them but `pricingUi()` does not return
   * them yet, so an API that hasn't caught up sends a `ui` block without them.
   * Each is rendered only when present rather than defaulted to an English
   * literal here — a hardcoded fallback sentence is exactly the drift the
   * catalog-travels-with-the-copy rule exists to prevent.
   */
  campaignBadge?: string;
  campaignEnds?: string;
  wasPrice?: string;
}

interface PricingCardsProps {
  plans: ApiPlan[];
  ui: ApiPricingUi;
  currentPlan?: PlanTierId | null;
  onSelectPlan?: (planId: PlanTierId) => void;
  subscribingPlan?: string | null;
  purchasesDisabled?: boolean;
  interval?: "monthly" | "annual";
  workspaceScoped?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatPrice(
  cents: number | null,
  ui: ApiPricingUi,
  interval: "monthly" | "annual" = "monthly",
): { label: string; suffix: string | null } {
  if (cents === null) return { label: ui.custom, suffix: null };
  if (cents === 0) return { label: ui.free, suffix: null };
  // Whole dollars stay whole ($39, not $39.00); a cents-precise price keeps them.
  return {
    label: `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`,
    suffix: interval === "annual" ? ui.perYear : ui.perMonth,
  };
}

/**
 * The two prices a card shows, and whether they differ.
 *
 * `listPrice`/`effectivePrice` are newer than this component's contract, so both
 * fall back to `price.monthly` — an older API sends only that, and reading it as
 * both list and charged keeps the card correct instead of blank.
 */
function resolveCardPrice(
  plan: ApiPlan,
  interval: "monthly" | "annual",
): {
  listCents: number | null;
  chargedCents: number | null;
  discounted: boolean;
} {
  if (interval === "annual")
    return { listCents: plan.price.annual, chargedCents: plan.price.annual, discounted: false };
  const listCents = plan.listPrice?.monthly ?? plan.price.monthly;
  const chargedCents = plan.effectivePrice?.monthly ?? listCents;
  return {
    listCents,
    chargedCents,
    // A campaign whose arithmetic didn't move the number (1% off a $0 tier) gets
    // no strike-through — there is nothing to compare.
    discounted:
      plan.campaign != null &&
      listCents != null &&
      chargedCents != null &&
      chargedCents !== listCents,
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

// Size the comparison to its container, including in the deploy modal. Four
// plans use two balanced rows until there is room for four readable cards.
const CARD_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 @min-[34rem]/pricing:grid-cols-2",
  3: "grid-cols-1 @min-[34rem]/pricing:grid-cols-2 @min-[52rem]/pricing:grid-cols-3",
  4: "grid-cols-1 @min-[34rem]/pricing:grid-cols-2 @min-[70rem]/pricing:grid-cols-4",
};

export const PricingCards: React.FC<PricingCardsProps> = ({
  plans,
  ui,
  currentPlan = "free",
  onSelectPlan,
  subscribingPlan,
  purchasesDisabled = false,
  interval = "monthly",
  workspaceScoped = false,
}) => {
  const { t, locale } = useI18n();
  const comparisonId = React.useId();
  const standard = resolveStandard(toPricingLocale(locale));
  // The reader's own calendar for a campaign deadline. Built once per render
  // rather than per card, and from `locale` (the chosen UI language) rather than
  // the browser default, which is what every other localized date here uses.
  const dateFmt = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }),
    [locale],
  );
  // A negotiated plan has no list price. Keep it out of the resource comparison;
  // discounted paid plans still belong there, even when the offer costs $0.
  const pricedPlans = plans.filter((plan) => plan.price.monthly !== null);
  const customPlans = plans.filter((plan) => plan.price.monthly === null);

  const comparison =
    pricedPlans.length > 0 ? (
      <div className={`grid gap-4 ${CARD_COLUMNS[Math.min(pricedPlans.length, 4)]}`}>
        {pricedPlans.map((plan) => {
          const { listCents, chargedCents, discounted } = resolveCardPrice(plan, interval);
          // Headline = what the customer pays today; the list price moves beside it.
          const { label, suffix } = formatPrice(
            discounted ? chargedCents : listCents,
            ui,
            interval,
          );
          const listLabel = formatPrice(listCents, ui, interval).label;
          const campaign = discounted ? plan.campaign : null;
          // A missing `campaignBadge` still shows the magnitude: "-50%" is a number
          // and a glyph, so it reads the same in every language.
          const badgeLabel = campaign
            ? ui.campaignBadge
              ? interpolate(ui.campaignBadge, { percentOff: String(campaign.percentOff) })
              : `-${campaign.percentOff}%`
            : null;
          // No fallback here on purpose: a bare date with no "offer ends" carrier
          // sentence is unreadable, so the line is dropped rather than guessed.
          const endsLabel =
            campaign && ui.campaignEnds
              ? interpolate(ui.campaignEnds, { date: dateFmt.format(new Date(campaign.endsAt)) })
              : null;
          const isCurrent = currentPlan === plan.id;
          const isPopular = plan.popular;
          // Purchasability reads the LIST price, never the effective one. A 100%-off
          // campaign leaves `effectivePrice.monthly === 0`, and keying off that would
          // render a paid tier with the free tier's "Free forever" plate and no
          // checkout button — the customer could never subscribe.
          const isPaid = plan.price[interval] !== null && plan.price[interval]! > 0;
          const isSubscribing = subscribingPlan === plan.id;
          const icon = <PlanIcon planId={plan.id} />;

          return (
            <article
              key={plan.id}
              id={`${comparisonId}-${plan.id}`}
              aria-label={plan.name}
              className={`relative min-w-0 scroll-mt-6 rounded-2xl bg-card p-5 ${
                isPopular ? "bg-gradient-to-b from-primary/5 to-card" : ""
              }`}
            >
              {/* Header */}
              <div className="mb-4 flex min-h-10 flex-wrap items-center gap-3">
                <div
                  className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                    isPopular ? "bg-primary/10 text-primary" : "bg-muted/60 text-foreground/80"
                  }`}
                >
                  {icon}
                </div>
                <h3 className="text-lg font-semibold tracking-tight text-foreground">
                  {plan.name}
                </h3>
                {isPopular && (
                  <span className="ms-auto rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                    {ui.mostPopular}
                  </span>
                )}
              </div>

              {/* Price */}
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-2xl font-medium tracking-tight tabular-nums text-foreground">
                  {label}
                </span>
                {suffix && (
                  <span className="text-sm font-medium text-muted-foreground">{suffix}</span>
                )}
                {campaign && (
                  <>
                    {/* The strike-through carries the meaning visually; `wasPrice`
                      carries it for a screen reader, which cannot hear one. */}
                    <span
                      className="text-sm font-medium tabular-nums text-muted-foreground line-through"
                      aria-label={
                        ui.wasPrice ? interpolate(ui.wasPrice, { price: listLabel }) : undefined
                      }
                    >
                      {listLabel}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">
                      {badgeLabel}
                    </span>
                  </>
                )}
              </div>
              <p className="mt-1 min-h-5 text-xs text-muted-foreground">
                {isPaid
                  ? interval === "annual"
                    ? t.billing.pricing.billedAnnually
                    : ui.billedMonthly
                  : ""}
              </p>
              {endsLabel && <p className="mt-0.5 text-xs font-medium text-success">{endsLabel}</p>}
              <p className="mb-4 mt-2 min-h-10 text-sm leading-5 text-muted-foreground">
                {plan.description}
              </p>

              {/* CTA */}
              <div className="mb-1">
                {isCurrent ? (
                  <div className="flex h-10 w-full items-center justify-center rounded-xl bg-muted/40 text-sm font-medium text-muted-foreground">
                    {t.billing.pricing.currentPlan}
                  </div>
                ) : plan.price.monthly === 0 ? (
                  <div className="flex h-10 w-full items-center justify-center rounded-xl bg-muted/40 text-sm font-medium text-muted-foreground">
                    {t.billing.pricing.freeForever}
                  </div>
                ) : isPaid ? (
                  <Button
                    type="button"
                    variant={isPopular ? "default" : "secondary"}
                    onClick={() => onSelectPlan?.(plan.id)}
                    disabled={!!subscribingPlan || purchasesDisabled}
                    className="w-full"
                  >
                    {isSubscribing ? (
                      <UiIcon name="spinner" className="size-4 animate-spin" />
                    ) : (
                      <>
                        {interpolate(ui.ctaChoose, { name: plan.name })}
                        <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" />
                      </>
                    )}
                  </Button>
                ) : null}
              </div>

              <PlanResources plan={plan} workspaceScoped={workspaceScoped} />
              <PlanFeatures plan={plan} />
            </article>
          );
        })}
      </div>
    ) : null;

  return (
    <div className="@container/pricing min-w-0 space-y-6">
      {plans.length > 1 && (
        <nav
          aria-label={t.billing.onboarding.choosePlan}
          className="flex flex-wrap gap-2 @min-[34rem]/pricing:hidden"
        >
          {plans.map((plan) => (
            <a
              key={plan.id}
              href={`#${comparisonId}-${plan.id}`}
              className="rounded-lg bg-muted/60 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {plan.name}
            </a>
          ))}
        </nav>
      )}
      {comparison}
      {customPlans.map((plan) => (
        <div
          key={plan.id}
          id={`${comparisonId}-${plan.id}`}
          className="flex scroll-mt-6 flex-col gap-4 rounded-2xl bg-card p-5 @min-[34rem]/pricing:flex-row @min-[34rem]/pricing:items-center"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <PlanIcon planId={plan.id} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold tracking-tight text-foreground">
                  {plan.name}
                </h3>
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {ui.custom}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
            </div>
          </div>
          {currentPlan === plan.id ? (
            <span className="flex h-10 shrink-0 items-center justify-center rounded-xl bg-muted/40 px-4 text-sm font-medium text-muted-foreground">
              {t.billing.pricing.currentPlan}
            </span>
          ) : plan.contactSales ? (
            <Button asChild variant="secondary" className="shrink-0">
              <a href={plan.contactSales}>
                {ui.ctaContact}
                <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" aria-hidden="true" />
              </a>
            </Button>
          ) : null}
        </div>
      ))}
      {pricedPlans.some((plan) => plan.id !== "free") && (
        <section className="px-1">
          <h3 className="text-sm font-medium text-foreground">{standard.title}</h3>
          <ul className="mt-3 grid gap-x-6 gap-y-2 @min-[34rem]/pricing:grid-cols-2 @min-[70rem]/pricing:grid-cols-3">
            {standard.features.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
                <UiIcon
                  name="check"
                  className="mt-1 size-3.5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <PlanUsageNote plans={plans} interval={interval} workspaceScoped={workspaceScoped} />
    </div>
  );
};
