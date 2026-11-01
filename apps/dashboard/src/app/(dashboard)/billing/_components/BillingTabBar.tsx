"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { BillingLink as Link } from "@/components/billing/BillingWorkspaceContext";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { BILLING_TABS, type BillingTab } from "./billing-tabs";
import { CloudPurchaseTabs } from "@/components/billing/CloudPurchaseContext";
import { usePendingCheckouts } from "@/components/billing/PendingCheckoutsContext";

export function BillingTabBar({
  activeTab,
  plansOnly = false,
  loading = false,
  topupsAvailable = false,
}: {
  activeTab: BillingTab;
  plansOnly?: boolean;
  loading?: boolean;
  topupsAvailable?: boolean;
}) {
  const { t } = useI18n();

  if (loading)
    return (
      <div
        aria-hidden="true"
        className="flex h-12 items-center gap-4 border-b border-border/50 px-3 sm:px-4"
      >
        <span className="h-4 w-28 rounded-md bg-muted/60 motion-safe:animate-pulse" />
      </div>
    );

  if (plansOnly)
    return (
      <CloudPurchaseTabs>
        <BillingTabLink tab={BILLING_TABS.find((tab) => tab.key === "payment")!} active={false} />
      </CloudPurchaseTabs>
    );

  return (
    <nav
      aria-label={t.billing.layout.title}
      className="flex items-center gap-1 overflow-x-auto border-b border-border/50"
    >
      {BILLING_TABS.filter((tab) => tab.key !== "topups" || topupsAvailable).map((tab) => (
        <BillingTabLink key={tab.key} tab={tab} active={activeTab === tab.key} />
      ))}
    </nav>
  );
}

function BillingTabLink({ tab, active }: { tab: (typeof BILLING_TABS)[number]; active: boolean }) {
  const { t, locale } = useI18n();
  const pending = usePendingCheckouts();
  const count = tab.key === "payment" ? (pending?.count ?? 0) : 0;
  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className={`relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-4 ${
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
      }`}
    >
      <UiIcon name={tab.icon} className="size-4" aria-hidden="true" />
      {t.billing.tabs[tab.key]}
      {count > 0 && (
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-warning-bg px-1.5 text-xs font-medium tabular-nums text-warning">
          <span aria-hidden="true">{new Intl.NumberFormat(locale).format(count)}</span>
          <span className="sr-only">
            {interpolate(t.billing.pendingPayments.count, { count: String(count) })}
          </span>
        </span>
      )}
      {active && <span className="absolute bottom-0 start-0 end-0 h-0.5 rounded-full bg-primary" />}
    </Link>
  );
}
