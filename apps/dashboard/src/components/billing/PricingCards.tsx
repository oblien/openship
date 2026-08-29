"use client";

import React from "react";
import {
  ArrowRight,
  Building2,
  Check,
  Crown,
  Loader2,
  Rocket,
  Sparkles,
  Zap,
} from "lucide-react";
import type { PlanLimits, PlanTierId } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";

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
  /**
   * The tier's ceilings in CUSTOMER-FACING units, straight off the pricing
   * catalog — typed as the catalog's own `PlanLimits` so a limit added or
   * removed there is a compile error here rather than a silently dead field.
   */
  limits: PlanLimits;
  /** Finished localized strings, numbers already interpolated by the catalog. */
  features: string[];
  /** "Everything in X, plus:" — a lead-in, NOT a bullet, so it renders above the
   *  ticked list without a checkmark of its own. */
  inheritedFrom?: string;
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
  currentPlan?: PlanTierId;
  onSelectPlan?: (planId: PlanTierId) => void;
  subscribingPlan?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Keyed by the full tier union so a new tier in the catalog is a compile
 *  error here rather than a card wearing another tier's icon. */
const PLAN_ICON: Record<PlanTierId, React.ReactNode> = {
  free: <Zap className="size-5" />,
  starter: <Rocket className="size-5" />,
  pro: <Crown className="size-5" />,
  team: <Building2 className="size-5" />,
  enterprise: <Sparkles className="size-5" />,
};

function formatPrice(
  cents: number | null,
  ui: ApiPricingUi,
): { label: string; suffix: string | null } {
  if (cents === null) return { label: ui.custom, suffix: null };
  if (cents === 0) return { label: ui.free, suffix: null };
  // Whole dollars stay whole ($39, not $39.00); a cents-precise price keeps them.
  return { label: `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`, suffix: ui.perMonth };
}

/**
 * The two prices a card shows, and whether they differ.
 *
 * `listPrice`/`effectivePrice` are newer than this component's contract, so both
 * fall back to `price.monthly` — an older API sends only that, and reading it as
 * both list and charged keeps the card correct instead of blank.
 */
function resolveCardPrice(plan: ApiPlan): {
  listCents: number | null;
  chargedCents: number | null;
  discounted: boolean;
} {
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

/**
 * Widest-breakpoint column count, keyed by how many cards there actually are.
 *
 * The count was pinned at `xl:grid-cols-5` while the catalog happened to publish
 * five cards. The moment the $0 tier stopped being rendered, the row kept five
 * tracks for four cards and left a column of empty space on the right — the grid
 * was describing the catalog as it was, not as it is.
 *
 * Written out as static class strings because Tailwind scans source text: a
 * computed `xl:grid-cols-${n}` compiles to nothing at all.
 */
const WIDEST_COLUMNS: Record<number, string> = {
  1: "xl:grid-cols-1",
  2: "xl:grid-cols-2",
  3: "xl:grid-cols-3",
  4: "xl:grid-cols-4",
  5: "xl:grid-cols-5",
};

export const PricingCards: React.FC<PricingCardsProps> = ({
  plans,
  ui,
  currentPlan = "free",
  onSelectPlan,
  subscribingPlan,
}) => {
  const { t, locale } = useI18n();
  // The reader's own calendar for a campaign deadline. Built once per render
  // rather than per card, and from `locale` (the chosen UI language) rather than
  // the browser default, which is what every other localized date here uses.
  const dateFmt = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }),
    [locale],
  );

  return (
    <div className={`grid gap-5 md:grid-cols-2 lg:grid-cols-3 ${WIDEST_COLUMNS[plans.length] ?? "xl:grid-cols-4"}`}>
      {plans.map((plan) => {
        const { listCents, chargedCents, discounted } = resolveCardPrice(plan);
        // Headline = what the customer pays today; the list price moves beside it.
        const { label, suffix } = formatPrice(discounted ? chargedCents : listCents, ui);
        const listLabel = formatPrice(listCents, ui).label;
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
        // No price + a sales address = negotiated tier. The address comes from
        // the catalog; a null price without one is not purchasable either.
        const salesUrl = plan.price.monthly === null ? (plan.contactSales ?? null) : null;
        const isPaid = plan.price.monthly !== null && plan.price.monthly > 0;
        const isSubscribing = subscribingPlan === plan.id;
        const icon = PLAN_ICON[plan.id] ?? <Sparkles className="size-5" />;

        return (
          <div
            key={plan.id}
            className={`relative flex flex-col rounded-2xl border bg-card p-6 transition-colors ${
              isPopular
                ? "border-primary/50 shadow-[0_0_0_1px_var(--primary)]"
                : "border-border/50 hover:border-border"
            }`}
          >
            {isPopular && (
              <span className="absolute -top-2.5 start-6 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary-foreground">
                {ui.mostPopular}
              </span>
            )}

            {/* Header */}
            <div className="mb-5 flex items-center gap-2.5">
              <div
                className={`flex size-9 items-center justify-center rounded-lg ${
                  isPopular
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {icon}
              </div>
              <h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
            </div>

            {/* Price */}
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-4xl font-bold tracking-tight tabular-nums text-foreground">
                {label}
              </span>
              {suffix && (
                <span className="text-sm font-medium text-muted-foreground">
                  {suffix}
                </span>
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
                  <span className="inline-flex items-center rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">
                    {badgeLabel}
                  </span>
                </>
              )}
            </div>
            <p className="mt-1 min-h-[1rem] text-[11px] text-muted-foreground">
              {isPaid ? ui.billedMonthly : ""}
            </p>
            {endsLabel && (
              <p className="mt-0.5 text-[11px] font-medium text-success">{endsLabel}</p>
            )}
            <p className="mb-6 mt-2 min-h-[2.5rem] text-[13px] leading-snug text-muted-foreground">
              {plan.description}
            </p>

            {/* CTA */}
            <div className="mb-5">
              {isCurrent ? (
                <div className="flex h-10 w-full items-center justify-center rounded-lg border border-border/50 bg-muted/40 text-sm font-medium text-muted-foreground">
                  {t.billing.pricing.currentPlan}
                </div>
              ) : salesUrl ? (
                <a
                  href={salesUrl}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border/50 bg-card text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
                >
                  {ui.ctaContact}
                  <ArrowRight className="size-3.5 rtl:rotate-180" />
                </a>
              ) : plan.price.monthly === 0 ? (
                <div className="flex h-10 w-full items-center justify-center rounded-lg border border-border/50 bg-muted/40 text-sm font-medium text-muted-foreground">
                  {t.billing.pricing.freeForever}
                </div>
              ) : isPaid ? (
                <button
                  type="button"
                  onClick={() => onSelectPlan?.(plan.id)}
                  disabled={!!subscribingPlan}
                  className={`flex h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60 ${
                    isPopular
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "border border-border/50 bg-card text-foreground hover:bg-muted/60"
                  }`}
                >
                  {isSubscribing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      {interpolate(ui.ctaChoose, { name: plan.name })}
                      <ArrowRight className="size-3.5 rtl:rotate-180" />
                    </>
                  )}
                </button>
              ) : null}
            </div>

            {/* Features */}
            {plan.inheritedFrom ? (
              <p className="border-t border-border/30 pt-5 text-[12px] font-medium text-muted-foreground">
                {plan.inheritedFrom}
              </p>
            ) : null}
            <ul
              className={`space-y-2.5 ${plan.inheritedFrom ? "pt-2.5" : "border-t border-border/30 pt-5"}`}
            >
              {plan.features.map((feature) => (
                <li
                  key={feature}
                  className="flex items-start gap-2 text-[13px] text-foreground/80"
                >
                  <Check
                    className={`mt-0.5 size-3.5 shrink-0 ${
                      isPopular ? "text-primary" : "text-muted-foreground"
                    }`}
                    strokeWidth={2.5}
                  />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
};
