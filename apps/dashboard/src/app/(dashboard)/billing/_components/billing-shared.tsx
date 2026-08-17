"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  BarChart3,
  Building2,
  Coins,
  CreditCard,
  Crown,
  LayoutDashboard,
  Receipt,
  Rocket,
  Sparkles,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PLAN_IDS, PLANS, type PlanTierId } from "@repo/core";
import type { BillingState } from "@/lib/api/billing";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";
import { OpenStripePortalButton } from "./OpenStripePortalButton";

type BillingStrings = Dictionary["billing"];

export type { BillingState };

export type BillingTab =
  | "overview"
  | "usage"
  | "plans"
  | "topups"
  | "payment"
  | "invoices";

export const BILLING_TABS: Array<{
  key: BillingTab;
  label: string;
  href: string;
  icon: LucideIcon;
}> = [
  { key: "overview", label: "Overview", href: "/billing/overview", icon: LayoutDashboard },
  { key: "usage", label: "Usage", href: "/billing/usage", icon: BarChart3 },
  { key: "plans", label: "Plans", href: "/billing/plans", icon: Crown },
  { key: "topups", label: "Top-ups", href: "/billing/topups", icon: Coins },
  { key: "payment", label: "Payment Method", href: "/billing/payment", icon: CreditCard },
  { key: "invoices", label: "Invoices", href: "/billing/invoices", icon: Receipt },
];

const PLAN_ICON: Record<PlanTierId, LucideIcon> = {
  free: Zap,
  starter: Rocket,
  pro: Sparkles,
  team: Building2,
  enterprise: Crown,
};

const PLAN_COLOR: Record<PlanTierId, string> = {
  free: "bg-muted text-muted-foreground",
  starter: "bg-muted text-foreground",
  pro: "bg-primary/10 text-primary",
  team: "bg-muted text-foreground",
  enterprise: "bg-muted text-foreground",
};

function BillingCtaLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`group relative inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-primary-foreground transition-all ${className}`}
    >
      <span className="pointer-events-none absolute -inset-[1px] rounded-xl bg-gradient-to-r from-primary via-blue-500 to-violet-500 opacity-40 blur-[1px] transition-opacity group-hover:opacity-60" />
      <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary to-primary/90" />
      <span className="relative flex items-center gap-1.5">{children}</span>
    </Link>
  );
}

/**
 * The sidebar's plan price — LIST price, from the catalog, and it must stay that
 * way here.
 *
 * `PLANS` is built at module load. This file is a client component, so a campaign
 * folded into that constant would be evaluated once when the browser bundle is
 * built and then frozen: the discount would keep rendering after the offer closed,
 * and a `revalidate` wouldn't help because re-running the component re-reads the
 * same frozen value. Campaign pricing is therefore only ever read from the API
 * payload (see `effectivePrice` / `campaign` on ApiPlan), which is resolved
 * per-request against a real `now`. If this line ever needs the discounted figure,
 * plumb it in from that payload — do not reach for the catalog.
 */
function formatPlanPrice(tier: PlanTierId, bt: BillingStrings): string {
  const monthly = PLANS[tier].price.monthly;
  if (monthly === 0) return bt.sidebar.freeForever;
  // No published price = a negotiated one (enterprise), never "not priced yet".
  if (monthly === null) return bt.sidebar.contactSales;
  return interpolate(bt.sidebar.perMonth, {
    price: (monthly / 100).toFixed(monthly % 100 === 0 ? 0 : 2),
  });
}

function formatStatusLabel(status: string, bt: BillingStrings): string {
  if (!status) return bt.sidebar.statusInactive;
  const known = (bt.sidebar.statuses as Record<string, string>)[status];
  if (known) return known;
  // Unknown/new Stripe status — fall back to a readable Title Case of the raw value.
  return status
    .split("_")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** The tier one step up the published ladder, read from the catalog so a new
 *  tier can't be skipped here. The negotiated top tier is not an "upgrade" —
 *  its card on the plans tab is a sales conversation, so it ends the ladder. */
function nextPlan(tier: PlanTierId): PlanTierId | undefined {
  const at = PLAN_IDS.indexOf(tier);
  const next = at < 0 ? undefined : PLAN_IDS[at + 1];
  return next && !PLANS[next].contactSales ? next : undefined;
}

export function BillingSidebar({ state }: { state: BillingState }) {
  const { t } = useI18n();
  const bt = t.billing;
  const plan = PLANS[state.tier];
  const next = nextPlan(state.tier);
  const PlanIcon = PLAN_ICON[state.tier];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex size-10 items-center justify-center rounded-xl ${PLAN_COLOR[state.tier]}`}>
            <PlanIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">
              {interpolate(bt.sidebar.planSuffix, { name: plan.name })}
            </p>
            <p className="text-xs text-muted-foreground">{formatPlanPrice(state.tier, bt)}</p>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
          <span className="text-xs text-muted-foreground">{bt.sidebar.status}</span>
          <span className="text-xs font-medium text-foreground">{formatStatusLabel(state.status, bt)}</span>
        </div>

        {next && (
          <BillingCtaLink href="/billing/plans" className="w-full justify-center">
            {interpolate(bt.sidebar.upgradeTo, { name: PLANS[next].name })}
            <ArrowUpRight className="size-3.5" />
          </BillingCtaLink>
        )}
      </div>
    </div>
  );
}

export function PaymentMethodPanel() {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="border-b border-border/50 p-5">
        <h2 className="text-base font-semibold text-foreground">{t.billing.paymentPanel.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.billing.paymentPanel.description}</p>
      </div>
      <div className="p-5">
        <OpenStripePortalButton />
      </div>
    </div>
  );
}

export function InvoicesPanel() {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="border-b border-border/50 p-5">
        <h2 className="text-base font-semibold text-foreground">{t.billing.invoicesPanel.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.billing.invoicesPanel.description}</p>
      </div>
      <div className="p-5">
        <OpenStripePortalButton />
      </div>
    </div>
  );
}
