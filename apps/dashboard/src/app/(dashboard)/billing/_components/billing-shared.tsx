import Link from "next/link";
import {
  ArrowUpRight,
  Building2,
  CreditCard,
  ExternalLink,
  FileText,
  HelpCircle,
  Receipt,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { type BillingData } from "@/components/billing/BillingOverview";
import { PLANS, type PlanId } from "@repo/core";

export type BillingTab = "overview" | "plans" | "payment" | "invoices";

export const BILLING_TABS: Array<{
  key: BillingTab;
  label: string;
  href: string;
  icon: LucideIcon;
}> = [
  { key: "overview", label: "Overview", href: "/billing/overview", icon: Sparkles },
  { key: "plans", label: "Plans", href: "/billing/plans", icon: Building2 },
  { key: "payment", label: "Payment Method", href: "/billing/payment", icon: CreditCard },
  { key: "invoices", label: "Invoices", href: "/billing/invoices", icon: Receipt },
];

const PLAN_ICON: Record<PlanId, LucideIcon> = {
  free: Zap,
  pro: Sparkles,
  team: Building2,
};

const PLAN_COLOR: Record<PlanId, string> = {
  free: "bg-muted text-muted-foreground",
  pro: "bg-primary/10 text-primary",
  team: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

const MOCK_INVOICES = [
  { date: "Apr 1, 2026", amount: "$20.00", status: "Paid" },
  { date: "Mar 1, 2026", amount: "$20.00", status: "Paid" },
];

export const MOCK_DATA: BillingData = {
  planId: "free",
  interval: "monthly",
  status: "active",
  usage: {
    projects: 2,
    deploymentsThisMonth: 14,
    customDomains: 0,
    teamMembers: 1,
    buildMinutes: 38,
    bandwidthGb: 0.3,
  },
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

export function BillingSidebar({ billingData }: { billingData: BillingData }) {
  const plan = PLANS[billingData.planId];
  const nextPlan = billingData.planId === "free" ? "pro" : billingData.planId === "pro" ? "team" : null;
  const PlanIcon = PLAN_ICON[billingData.planId];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex size-10 items-center justify-center rounded-xl ${PLAN_COLOR[billingData.planId]}`}>
            <PlanIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{plan.name} Plan</p>
            <p className="text-xs text-muted-foreground">
              {plan.price === 0 ? "Free forever" : `$${plan.price}/mo`}
            </p>
          </div>
        </div>

        {nextPlan && (
          <BillingCtaLink href="/billing/plans" className="w-full justify-center">
            Upgrade to {PLANS[nextPlan].name}
            <ArrowUpRight className="size-3.5" />
          </BillingCtaLink>
        )}
      </div>

      <div className="rounded-2xl border border-border/50 bg-card p-5">
        <h3 className="mb-3 text-sm font-medium text-foreground">Resources</h3>
        <div className="space-y-1">
          <a
            href="#"
            className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <HelpCircle className="size-4" />
            Billing FAQ
            <ExternalLink className="ml-auto size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </a>
          <a
            href="#"
            className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <Shield className="size-4" />
            Usage Policy
            <ExternalLink className="ml-auto size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </a>
          <Link
            href="/billing/plans"
            className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <Receipt className="size-4" />
            Pricing Details
            <ExternalLink className="ml-auto size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </Link>
        </div>
      </div>
    </div>
  );
}

export function PaymentMethodPanel({ billingData }: { billingData: BillingData }) {
  if (billingData.planId === "free") {
    return (
      <div className="rounded-2xl border border-border/50 bg-card">
        <div className="border-b border-border/50 p-5">
          <h2 className="text-base font-semibold text-foreground">Payment Method</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a payment method once you move to a paid plan.
          </p>
        </div>
        <div className="p-5">
          <div className="rounded-xl border border-dashed border-border/60 bg-muted/30 p-5">
            <p className="text-sm text-muted-foreground">
              No payment method required on the Free plan.
            </p>
            <BillingCtaLink href="/billing/plans" className="mt-4">
              View paid plans
              <ArrowUpRight className="size-3.5" />
            </BillingCtaLink>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="border-b border-border/50 p-5">
        <h2 className="text-base font-semibold text-foreground">Payment Method</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage the card or account used for your subscription.
        </p>
      </div>
      <div className="p-5">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-muted/20 p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
              <CreditCard className="size-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">•••• 4242</p>
              <p className="text-xs text-muted-foreground">Expires 12/27</p>
            </div>
          </div>
          <button className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted">
            Update
          </button>
        </div>
      </div>
    </div>
  );
}

export function InvoicesPanel({ billingData }: { billingData: BillingData }) {
  if (billingData.planId === "free") {
    return (
      <div className="rounded-2xl border border-border/50 bg-card">
        <div className="border-b border-border/50 p-5">
          <h2 className="text-base font-semibold text-foreground">Invoices</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Billing history for your workspace.
          </p>
        </div>
        <div className="p-5">
          <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border/60 bg-muted/30 p-5">
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
              <FileText className="size-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">No invoices yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Invoices will appear here when you upgrade.
              </p>
            </div>
            <BillingCtaLink href="/billing/plans">
              View plans
              <ArrowUpRight className="size-3.5" />
            </BillingCtaLink>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center justify-between border-b border-border/50 p-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">Invoices</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Download receipts and review past charges.
          </p>
        </div>
        <button className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
          View all
        </button>
      </div>
      <div className="p-5">
        <div className="space-y-2">
          {MOCK_INVOICES.map((invoice) => (
            <div
              key={invoice.date}
              className="flex items-center justify-between rounded-xl border border-border/50 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
                  <FileText className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{invoice.date}</p>
                  <p className="text-xs text-muted-foreground">Monthly subscription</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-medium tabular-nums text-foreground">{invoice.amount}</p>
                <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{invoice.status}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}